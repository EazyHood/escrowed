import test from 'node:test';
import assert from 'node:assert/strict';
import { SingleFlight } from '../src/lib/single-flight.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('rapid clicks across three examples start only one lookup and restore controls on success', async () => {
  const controlStates = [];
  const lookup = new SingleFlight(busy => controlStates.push(busy));
  const rpc = deferred();
  let calls = 0;
  const inspect = async () => { calls++; return rpc.promise; };
  const funded = lookup.run(inspect);
  const awarded = lookup.run(inspect);
  const refunded = lookup.run(inspect);
  assert.equal(funded, awarded);
  assert.equal(funded, refunded);
  assert.equal(lookup.busy, true);
  await Promise.resolve();
  assert.equal(calls, 1);
  rpc.resolve('Funded');
  assert.deepEqual(await Promise.all([funded, awarded, refunded]), ['Funded', 'Funded', 'Funded']);
  assert.equal(lookup.busy, false);
  assert.deepEqual(controlStates, [true, false]);
});

test('RPC failure restores every lookup control and permits an explicit retry', async () => {
  const controlStates = [];
  const lookup = new SingleFlight(busy => controlStates.push(busy));
  await assert.rejects(lookup.run(async () => { throw new Error('429'); }), /429/);
  assert.equal(lookup.busy, false);
  assert.equal(await lookup.run(async () => 'Awarded'), 'Awarded');
  assert.deepEqual(controlStates, [true, false, true, false]);
});

test('discarding an edited or navigated-away result does not unlock its still-running network request', async () => {
  const lookup = new SingleFlight();
  const rpc = deferred();
  let inputVersion = 1;
  let displayed = false;
  let duplicateStarted = false;
  const first = lookup.run(async () => {
    const version = inputVersion;
    await rpc.promise;
    if (version === inputVersion) displayed = true;
  });
  await Promise.resolve();
  inputVersion++; // The UI invalidates a result, without cancelling HTTP itself.
  const second = lookup.run(async () => { duplicateStarted = true; });
  assert.equal(lookup.busy, true);
  rpc.resolve();
  await Promise.all([first, second]);
  assert.equal(displayed, false);
  assert.equal(duplicateStarted, false);
  assert.equal(lookup.busy, false);
});

test('post-transaction refresh can wait for the old lookup before starting a fresh read', async () => {
  const lookup = new SingleFlight();
  const rpc = deferred();
  const order = [];
  const first = lookup.run(async () => { await rpc.promise; order.push('old completed'); });
  const refresh = (async () => { await lookup.wait(); await lookup.run(async () => { order.push('fresh read'); }); })();
  await Promise.resolve();
  assert.deepEqual(order, []);
  rpc.resolve();
  await Promise.all([first, refresh]);
  assert.deepEqual(order, ['old completed', 'fresh read']);
});
