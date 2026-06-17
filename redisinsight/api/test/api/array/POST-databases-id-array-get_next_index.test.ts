import {
  expect,
  describe,
  it,
  before,
  deps,
  Joi,
  requirements,
  tag,
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

// Service issues ARNEXT (the ARINSERT cursor — a piece of array-level state
// that ARINSERT advances and ARSEEK repositions, independent of which slots
// ARSET/ARMSET have populated) and maps the reply through toIndexString, so
// `index` is the cursor as a decimal string — or null when Redis reports
// the cursor as exhausted (no further insertion possible).
const responseSchema = Joi.object()
  .keys({
    keyName: JoiRedisString.required(),
    index: Joi.string().pattern(/^\d+$/).allow(null).required(),
  })
  .required();

const mainCheckFn = getMainCheckFn(endpoint);

describe('POST /databases/:instanceId/array/get-next-index', () => {
  tag('array');
  requirements('rte.version>=8.8');
  beforeEach(async () => rte.data.truncate());

  describe('Validation', () => {
    generateInvalidDataTestCases(dataSchema, validInputData).map(
      validateInvalidDataTestCase(endpoint, dataSchema),
    );
  });

  describe('Main', () => {
    it('Should return cursor 0 for a key populated only via ARSET', async () => {
      const keyName = constants.getRandomString();
      // ARSET writes to specific indexes but does NOT advance the insertion
      // cursor — that surface is reserved for ARINSERT. Pins the semantic
      // boundary: this endpoint exposes the ARINSERT cursor, not the array
      // length (use /array/get-length for that).
      await rte.client.call('ARSET', keyName, '0', 'a', '1', 'b', '2', 'c');

      await validateApiCall({
        endpoint,
        data: { keyName },
        responseSchema,
        responseBody: { keyName, index: '0' },
        checkFn: ({ body }: any) => {
          // String contract — guards against any future numeric-coercion regression.
          expect(typeof body.index).to.eql('string');
        },
      });
    });

    it('Should advance the cursor by one per value inserted via ARINSERT', async () => {
      const keyName = constants.getRandomString();
      // ARINSERT writes at the cursor position and advances the cursor by
      // one per value, so after three values the cursor sits at 3 — exactly
      // what ARNEXT must report.
      await rte.client.call('ARINSERT', keyName, 'a', 'b', 'c');

      await validateApiCall({
        endpoint,
        data: { keyName },
        responseSchema,
        responseBody: { keyName, index: '3' },
      });
    });

    it('Should reflect an explicit cursor reposition via ARSEEK', async () => {
      const keyName = constants.getRandomString();
      // ARINSERT to create the array and advance the cursor to 2; ARSEEK
      // then jumps it to 100. ARNEXT must mirror the moved cursor — locks
      // in that the response tracks state, not the inserted-value count.
      await rte.client.call('ARINSERT', keyName, 'a', 'b');
      await rte.client.call('ARSEEK', keyName, '100');

      await validateApiCall({
        endpoint,
        data: { keyName },
        responseSchema,
        responseBody: { keyName, index: '100' },
      });
    });

    it('Should return null when the cursor is exhausted', async () => {
      const keyName = constants.getRandomString();
      // Reach exhaustion: ARSEEK to the max valid index (2^64-2) then
      // ARINSERT one element. The next slot would be 2^64-1, which Redis
      // reserves as the no-index sentinel — ARNEXT reports the cursor as
      // exhausted via a nil reply, which toIndexString must surface as
      // JSON null (NOT the literal string "null").
      await rte.client.call('ARSEEK', keyName, '18446744073709551614');
      await rte.client.call('ARINSERT', keyName, 'last');

      await validateApiCall({
        endpoint,
        data: { keyName },
        responseSchema,
        responseBody: { keyName, index: null },
      });
    });

    it('Should round-trip a cursor above MAX_SAFE_INTEGER', async () => {
      const keyName = constants.getRandomString();
      // ARSEEK to a u64 cursor that exceeds Number.MAX_SAFE_INTEGER (2^53-1).
      // If the wire path ever decodes the integer reply as a JS number,
      // precision is silently lost — this assertion catches that regression.
      const hugeCursor = '9223372036854775818';
      await rte.client.call('ARSEEK', keyName, hugeCursor);

      await validateApiCall({
        endpoint,
        data: { keyName },
        responseSchema,
        responseBody: { keyName, index: hugeCursor },
        checkFn: ({ body }: any) => {
          expect(typeof body.index).to.eql('string');
          expect(body.index).to.eql(hugeCursor);
        },
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
        // beforeEach() wipes the key between tests; reseed via the root
        // client (ACL rules below only affect the API request).
        before: async () => {
          await rte.client.call('ARSET', aclKey, '0', 'x');
          await rte.data.setAclUserRules('~* +@all -arnext');
        },
      },
    ].map(mainCheckFn);
  });
});
