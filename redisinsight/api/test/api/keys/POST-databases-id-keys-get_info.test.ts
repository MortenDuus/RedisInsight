import {
  expect,
  describe,
  it,
  before,
  deps,
  Joi,
  requirements,
  generateInvalidDataTestCases,
  validateInvalidDataTestCase,
  validateApiCall,
  JoiRedisString,
} from '../deps';
const { server, request, constants, rte } = deps;

// endpoint to test
const endpoint = (instanceId = constants.TEST_INSTANCE_ID) =>
  request(server).post(
    `/${constants.API.DATABASES}/${instanceId}/keys/get-info`,
  );

// input data schema
const dataSchema = Joi.object({
  keyName: Joi.string().allow('').required(),
}).strict();

const validInputData = {
  keyName: constants.TEST_LIST_KEY_1,
};

const responseSchema = Joi.object()
  .keys({
    name: JoiRedisString.required(),
    type: Joi.string().required(),
    ttl: Joi.number().integer().allow(null).optional(),
    size: Joi.number().integer().allow(null).optional(),
    length: Joi.number().integer().required(),
  })
  .required();

const mainCheckFn = async (testCase) => {
  it(testCase.name, async () => {
    if (testCase.before) {
      await testCase.before();
    }

    await validateApiCall({
      endpoint,
      ...testCase,
    });
  });
};

describe('POST /databases/:instanceId/keys/get-info', () => {
  before(async () => await rte.data.generateKeys(true));

  describe('Validation', () => {
    generateInvalidDataTestCases(dataSchema, validInputData).map(
      validateInvalidDataTestCase(endpoint, dataSchema),
    );
  });

  describe('Modes', () => {
    requirements('!rte.bigData');
    before(rte.data.generateBinKeys);

    [
      {
        name: 'Should return string info in utf8 (default)',
        data: {
          keyName: constants.TEST_STRING_KEY_BIN_BUF_OBJ_1,
        },
        responseSchema,
        checkFn: ({ body }) => {
          expect(body.name).to.eq(constants.TEST_STRING_KEY_BIN_UTF8_1);
        },
      },
      {
        name: 'Should return string info in utf8',
        query: {
          encoding: 'utf8',
        },
        data: {
          keyName: constants.TEST_STRING_KEY_BIN_BUF_OBJ_1,
        },
        responseSchema,
        checkFn: ({ body }) => {
          expect(body.name).to.eq(constants.TEST_STRING_KEY_BIN_UTF8_1);
        },
      },
      {
        name: 'Should return string info in ASCII',
        query: {
          encoding: 'ascii',
        },
        data: {
          keyName: constants.TEST_STRING_KEY_BIN_ASCII_1,
        },
        responseSchema,
        checkFn: ({ body }) => {
          expect(body.name).to.eq(constants.TEST_STRING_KEY_BIN_ASCII_1);
        },
      },
      {
        name: 'Should return string info in Buffer',
        query: {
          encoding: 'buffer',
        },
        data: {
          keyName: constants.TEST_STRING_KEY_BIN_BUF_OBJ_1,
        },
        responseSchema,
        checkFn: ({ body }) => {
          expect(body.name).to.deep.eq(constants.TEST_STRING_KEY_BIN_BUF_OBJ_1);
        },
      },
      {
        name: 'Should return error when send unicode with unprintable chars',
        query: {
          encoding: 'buffer',
        },
        data: {
          keyName: constants.TEST_STRING_KEY_BIN_UTF8_1,
        },
        statusCode: 404,
      },
    ].map(mainCheckFn);
  });

  describe('Common', () => {
    [
      {
        name: 'Should return string info',
        data: {
          keyName: constants.TEST_STRING_KEY_1,
        },
        responseSchema,
        responseBody: {
          name: constants.TEST_STRING_KEY_1,
          type: constants.TEST_STRING_TYPE,
          ttl: -1,
          length: constants.TEST_STRING_VALUE_1.length,
        },
      },
      {
        name: 'Should return list info',
        data: {
          keyName: constants.TEST_LIST_KEY_1,
        },
        responseSchema,
        responseBody: {
          name: constants.TEST_LIST_KEY_1,
          type: constants.TEST_LIST_TYPE,
          ttl: -1,
          length: 2,
        },
      },
      {
        name: 'Should return set info',
        data: {
          keyName: constants.TEST_SET_KEY_1,
        },
        responseSchema,
        responseBody: {
          name: constants.TEST_SET_KEY_1,
          type: constants.TEST_SET_TYPE,
          ttl: -1,
          length: 1,
        },
      },
      {
        name: 'Should return zset info',
        data: {
          keyName: constants.TEST_ZSET_KEY_1,
        },
        responseSchema,
        responseBody: {
          name: constants.TEST_ZSET_KEY_1,
          type: constants.TEST_ZSET_TYPE,
          ttl: -1,
          length: 2,
        },
      },
      {
        name: 'Should return hash info',
        data: {
          keyName: constants.TEST_HASH_KEY_1,
        },
        responseSchema,
        responseBody: {
          name: constants.TEST_HASH_KEY_1,
          type: constants.TEST_HASH_TYPE,
          ttl: -1,
          length: 2,
        },
      },
      {
        name: 'Should return NotFound error for not existing error',
        data: {
          keyName: constants.getRandomString(),
        },
        statusCode: 404,
        responseBody: {
          statusCode: 404,
          error: 'Not Found',
          message: 'Key with this name does not exist.',
        },
      },
    ].map(mainCheckFn);

    describe('ReJSON-RL', () => {
      requirements('rte.modules.rejson');
      [
        {
          name: 'Should return ReJSON info',
          data: {
            keyName: constants.TEST_REJSON_KEY_1,
          },
          responseSchema,
          responseBody: {
            name: constants.TEST_REJSON_KEY_1,
            type: constants.TEST_REJSON_TYPE,
            ttl: -1,
            length: 1,
          },
        },
      ].map(mainCheckFn);
    });

    describe('Array', () => {
      // Redis 8.8 preview type — exercises the GetArrayKeyInfoResponse branch
      // of the keys/get-info `oneOf` response and the ArrayKeyInfoStrategy.
      requirements('rte.version>=8.8');

      const denseKey = constants.getRandomString();
      const sparseKey = constants.getRandomString();

      before(async () => {
        // The shared `rte` destructure is typed as null until initRTE runs;
        // cast once for the seeding block to keep the file's TS-error baseline.
        const client = (rte as any).client;
        await client.call('ARSET', denseKey, '0', 'a', 'b', 'c');
        // Sparse: indexes 0,5 populated → length=6, count=2. The divergence
        // is the whole reason ArrayKeyInfoStrategy issues both ARLEN and
        // ARCOUNT instead of one or the other.
        await client.call('ARMSET', sparseKey, '0', 'v0', '5', 'v5');
      });

      const arrayResponseSchema = Joi.object()
        .keys({
          name: JoiRedisString.required(),
          type: Joi.string().valid('array').required(),
          ttl: Joi.number().integer().allow(null).optional(),
          size: Joi.number().integer().allow(null).optional(),
          // Decimal-string contract: ARLEN / ARCOUNT can exceed
          // Number.MAX_SAFE_INTEGER for sparse arrays, so the response
          // surfaces them as strings — never numbers.
          length: Joi.string().pattern(/^\d+$/).required(),
          count: Joi.string().pattern(/^\d+$/).required(),
        })
        .required();

      [
        {
          name: 'Should return array info with length === count for a dense array',
          data: { keyName: denseKey },
          responseSchema: arrayResponseSchema,
          responseBody: {
            name: denseKey,
            type: 'array',
            length: '3',
            count: '3',
          },
        },
        {
          name: 'Should return array info with length !== count for a sparse array',
          data: { keyName: sparseKey },
          responseSchema: arrayResponseSchema,
          responseBody: {
            name: sparseKey,
            type: 'array',
            length: '6',
            count: '2',
          },
        },
      ].map(mainCheckFn);
    });
  });

  describe('ACL', () => {
    requirements('rte.acl');
    before(async () => rte.data.setAclUserRules('~* +@all'));

    const mainACLCheckFn = async (testCase) => {
      it(testCase.name, async () => {
        if (testCase.before) {
          await testCase.before();
        }

        await validateApiCall({
          endpoint: () => endpoint(constants.TEST_INSTANCE_ACL_ID),
          ...testCase,
          checkFn: ({ body }) => {
            expect(body.ttl).to.be.oneOf([null, undefined]);
            expect(body.length).to.be.oneOf([null, undefined]);
            expect(body.size).to.be.oneOf([null, undefined]);
          },
        });
      });
    };

    [
      {
        name: 'Should return key info',
        endpoint: () => endpoint(constants.TEST_INSTANCE_ACL_ID),
        data: {
          keyName: constants.TEST_STRING_KEY_1,
        },
        statusCode: 200,
      },
      {
        name: 'Should throw error if no permissions for "type" command',
        endpoint: () => endpoint(constants.TEST_INSTANCE_ACL_ID),
        data: {
          keyName: constants.TEST_STRING_KEY_1,
        },
        statusCode: 403,
        responseBody: {
          statusCode: 403,
          error: 'Forbidden',
        },
        before: () => rte.data.setAclUserRules('~* +@all -type'),
      },
    ].map(mainCheckFn);

    [
      {
        name: 'Should return empty fields if no permission for (ttl, memory, strlen)',
        data: {
          keyName: constants.TEST_STRING_KEY_1,
        },
        responseBody: {
          name: constants.TEST_STRING_KEY_1,
          type: constants.TEST_STRING_TYPE,
        },
        before: () => rte.data.setAclUserRules('~* +@all -ttl -memory -strlen'),
      },
      {
        name: 'Should return empty fields if no permission for (ttl, memory, llen)',
        data: {
          keyName: constants.TEST_LIST_KEY_1,
        },
        responseBody: {
          name: constants.TEST_LIST_KEY_1,
          type: constants.TEST_LIST_TYPE,
        },
        before: () => rte.data.setAclUserRules('~* +@all -ttl -memory -llen'),
      },
      {
        name: 'Should return empty fields if no permission for (ttl, memory, scard)',
        data: {
          keyName: constants.TEST_SET_KEY_1,
        },
        responseBody: {
          name: constants.TEST_SET_KEY_1,
          type: constants.TEST_SET_TYPE,
        },
        before: () => rte.data.setAclUserRules('~* +@all -ttl -memory -scard'),
      },
      {
        name: 'Should return empty fields if no permission for (ttl, memory, zcard)',
        data: {
          keyName: constants.TEST_ZSET_KEY_1,
        },
        responseBody: {
          name: constants.TEST_ZSET_KEY_1,
          type: constants.TEST_ZSET_TYPE,
        },
        before: () => rte.data.setAclUserRules('~* +@all -ttl -memory -zcard'),
      },
      {
        name: 'Should return empty fields if no permission for (ttl, memory, zcard)',
        data: {
          keyName: constants.TEST_ZSET_KEY_1,
        },
        responseBody: {
          name: constants.TEST_ZSET_KEY_1,
          type: constants.TEST_ZSET_TYPE,
        },
        before: () => rte.data.setAclUserRules('~* +@all -ttl -memory -zcard'),
      },
      {
        name: 'Should return empty fields if no permission for (ttl, memory, usage, hlen)',
        data: {
          keyName: constants.TEST_HASH_KEY_1,
        },
        responseBody: {
          name: constants.TEST_HASH_KEY_1,
          type: constants.TEST_HASH_TYPE,
        },
        before: () => rte.data.setAclUserRules('~* +@all -ttl -memory -hlen'),
      },
    ].map(mainACLCheckFn);
    //json.type
    describe('ReJSON-RL', () => {
      requirements('rte.modules.rejson');

      [
        {
          name: 'Should return empty fields if no permission for (ttl, memory, json.type)',
          data: {
            keyName: constants.TEST_REJSON_KEY_1,
          },
          responseBody: {
            name: constants.TEST_REJSON_KEY_1,
            type: constants.TEST_REJSON_TYPE,
          },
          before: () =>
            rte.data.setAclUserRules('~* +@all -ttl -memory -json.type'),
        },
      ].map(mainACLCheckFn);
    });
  });
});
