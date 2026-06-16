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
  getMainCheckFn,
  JoiRedisString,
} from '../deps';

const { server, request, constants } = deps;
const rte = deps.rte as any;

const endpoint = (instanceId = constants.TEST_INSTANCE_ID) =>
  request(server).post(
    `/${constants.API.DATABASES}/${instanceId}/array/get-next-index`,
  );

const dataSchema = Joi.object({
  keyName: Joi.string().allow('').required(),
}).strict();

const validInputData = {
  keyName: constants.getRandomString(),
};

// ARNEXT returns nil when the insertion cursor is exhausted (toIndexString
// passes the nil through as JSON null), so index is string | null.
const responseSchema = Joi.object()
  .keys({
    keyName: JoiRedisString.required(),
    index: Joi.string().pattern(/^\d+$/).allow(null).required(),
  })
  .required();

const mainCheckFn = getMainCheckFn(endpoint);

describe('POST /databases/:instanceId/array/get-next-index', () => {
  requirements('rte.version>=8.8');
  beforeEach(async () => rte.data.truncate());

  describe('Validation', () => {
    generateInvalidDataTestCases(dataSchema, validInputData).map(
      validateInvalidDataTestCase(endpoint, dataSchema),
    );
  });

  describe('Main', () => {
    it('Should return next index for a dense array starting at 0', async () => {
      const keyName = constants.getRandomString();
      await rte.client.call('ARSET', keyName, '0', 'a', 'b', 'c');

      await validateApiCall({
        endpoint,
        data: { keyName },
        responseSchema,
        responseBody: { keyName, index: '3' },
        checkFn: ({ body }: any) => {
          // String contract — guards against any future numeric-coercion regression.
          expect(typeof body.index).to.eql('string');
        },
      });
    });

    it('Should return next index after the highest populated slot for a sparse array', async () => {
      const keyName = constants.getRandomString();
      await rte.client.call('ARMSET', keyName, '0', 'a', '1', 'b', '5', 'c');

      // Insertion cursor advances past the highest set index, not just the
      // populated count — ARNEXT must follow ARLEN, not ARCOUNT.
      await validateApiCall({
        endpoint,
        data: { keyName },
        responseSchema,
        responseBody: { keyName, index: '6' },
      });
    });

    [
      {
        name: 'Should return BadRequest if key holds a non-array type',
        data: { keyName: constants.TEST_STRING_KEY_1 },
        statusCode: 400,
        before: () => rte.data.generateKeys(true),
      },
      {
        name: 'Should return NotFound if key does not exist',
        data: { keyName: constants.getRandomString() },
        statusCode: 404,
        responseBody: {
          statusCode: 404,
          error: 'Not Found',
          message: 'Key with this name does not exist.',
        },
      },
      {
        name: 'Should return NotFound if instance id does not exist',
        endpoint: () => endpoint(constants.TEST_NOT_EXISTED_INSTANCE_ID),
        data: { keyName: constants.getRandomString() },
        statusCode: 404,
        responseBody: {
          statusCode: 404,
          error: 'Not Found',
          message: 'Invalid database instance id.',
        },
      },
    ].map(mainCheckFn);
  });

  describe('ACL', () => {
    requirements('rte.acl');
    before(async () => rte.data.setAclUserRules('~* +@all'));

    const aclEndpoint = () => endpoint(constants.TEST_INSTANCE_ACL_ID);
    const aclKey = constants.getRandomString();

    [
      {
        name: 'Should return next index for an authorised user',
        endpoint: aclEndpoint,
        data: { keyName: aclKey },
        responseSchema,
        before: async () => {
          await rte.data.setAclUserRules('~* +@all');
          await rte.client.call('ARSET', aclKey, '0', 'x');
        },
      },
      {
        name: 'Should throw error if no permissions for "arnext" command',
        endpoint: aclEndpoint,
        data: { keyName: aclKey },
        statusCode: 403,
        responseBody: { statusCode: 403, error: 'Forbidden' },
        before: () => rte.data.setAclUserRules('~* +@all -arnext'),
      },
    ].map(mainCheckFn);
  });
});
