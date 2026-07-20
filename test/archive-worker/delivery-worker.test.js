const { DeliveryWorker } = require('../../archive-worker/delivery-worker');

function databaseFor(job) {
  return {
    listDeliveryJobs: () => [job],
    updateDeliveryJob: jest.fn((id, status, details) => ({
      id,
      status,
      ...details,
    })),
  };
}

test('delivers and records acknowledgement', async () => {
  const database = databaseFor({
    id: 1,
    destination: 'vitasci-crm',
    attempts: 0,
  });
  const worker = new DeliveryWorker({
    database,
    adapters: {
      'vitasci-crm': {
        deliver: async () => ({
          accepted: true,
          manifestDigest: 'd',
          destinationRecordId: 'r1',
        }),
      },
    },
  });
  const result = await worker.processPending();
  expect(result[0]).toMatchObject({
    status: 'delivered',
    destinationRecordId: 'r1',
  });
});

test('routes missing adapters to review', async () => {
  const database = databaseFor({ id: 2, destination: 'unknown', attempts: 0 });
  const result = await new DeliveryWorker({
    database,
    adapters: {},
  }).processPending();
  expect(result[0]).toMatchObject({
    status: 'review',
    error: 'destination-adapter-missing',
  });
});
