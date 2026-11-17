const assert = require('node:assert/strict');
const test = require('node:test');
const { createFavoriteRefresher } = require('../dist-electron/shared/favorite-refresh.js');
const { expireFavoriteStatuses, favoriteStatusMaxAgeMs, getFavoriteRooms, updateFavoriteCollection } = require('../dist-electron/shared/favorites.js');

const room = {
  id: 'douyin-123', platform: 'douyin', webUrl: 'https://live.douyin.com/456', title: 'Stream', anchor: 'Anchor',
  category: 'Games', tags: [], cover: '', viewers: 10, status: 'live', updatedAt: '刚刚', checkedAt: Date.now() - 1000,
};
function setup(request) {
  let collection = { version: 2, ids: ['douyin-web-456'], rooms: [room] };
  const refresh = createFavoriteRefresher({ read: () => collection, save: c => { collection = c; }, request });
  return { refresh, read: () => collection, write: c => { collection = c; } };
}

test('a refresh detects ending and restarting a stream even when the directory no longer contains it', async () => {
  let live = false;
  const state = setup(async ids => {
    assert.deepEqual(ids, ['douyin-web-456']);
    return { rooms: [{ ...room, id: live ? 'douyin-789' : 'douyin-123', status: live ? 'live' : 'offline', checkedAt: Date.now() }], failedIds: [] };
  });
  await state.refresh();
  assert.equal(state.read().rooms[0].status, 'offline');
  state.write(updateFavoriteCollection(state.read(), [room]));
  assert.equal(state.read().rooms[0].status, 'offline');
  live = true;
  await state.refresh();
  assert.equal(state.read().rooms.length, 1);
  assert.equal(state.read().rooms[0].id, 'douyin-789');
  assert.equal(state.read().rooms[0].status, 'live');
});

test('failed stable Douyin keys clear a saved live session and keep the anchor', async () => {
  for (const request of [async () => ({ rooms: [], failedIds: ['douyin-web-456'] }), async () => { throw new Error('IPC failed'); }]) {
    const state = setup(request);
    assert.equal(await state.refresh(), 1);
    assert.deepEqual(state.read().ids, ['douyin-web-456']);
    assert.equal(state.read().rooms[0].anchor, 'Anchor');
    assert.equal(state.read().rooms[0].status, 'unknown');
    assert.equal(updateFavoriteCollection(state.read(), [room]).rooms[0].status, 'unknown');
  }
});

test('overlapping automatic and manual refreshes share the request, and the next click requests again', async () => {
  let complete;
  let calls = 0;
  const state = setup(() => { calls++; return new Promise(resolve => { complete = resolve; }); });
  const first = state.refresh();
  const second = state.refresh();
  assert.equal(first, second);
  assert.equal(calls, 1);
  complete({ rooms: [], failedIds: ['douyin-web-456'] });
  await first;
  const next = state.refresh();
  assert.equal(calls, 2);
  complete({ rooms: [], failedIds: ['douyin-web-456'] });
  await next;
});

test('removing favorites during a request does not resurrect them', async () => {
  let complete;
  const state = setup(() => new Promise(resolve => { complete = resolve; }));
  const pending = state.refresh();
  state.write({ version: 2, ids: [], rooms: [] });
  complete({ rooms: [{ ...room, checkedAt: Date.now() }], failedIds: [] });
  await pending;
  assert.deepEqual(state.read().ids, []);
  assert.deepEqual(state.read().rooms, []);
});

test('favorites added while a request is in flight are checked before refresh completes', async () => {
  let complete;
  const batches = [];
  const state = setup(batch => {
    batches.push(batch);
    return batches.length === 1 ? new Promise(resolve => { complete = resolve; })
      : Promise.resolve({ rooms: [], failedIds: batch });
  });
  const pending = state.refresh();
  state.write({ ...state.read(), ids: [...state.read().ids, 'huya-688'] });
  complete({ rooms: [], failedIds: ['douyin-web-456'] });
  await pending;
  assert.deepEqual(batches, [['douyin-web-456'], ['huya-688']]);
});

test('refresh batches all platforms, preserves legacy entries, and handles missing metadata on failure', async () => {
  const ids = Array.from({ length: 101 }, (_, i) => `huya-${i + 1}`);
  ids.push('douyin-web-456', 'bilibili-123', 'douyu-789', 'douyin-999');
  const batches = [];
  const state = setup(async batch => { batches.push(batch); return { rooms: [], failedIds: batch }; });
  state.write({ version: 2, ids, rooms: [] });
  assert.equal(await state.refresh(), 104);
  assert.deepEqual(batches.map(b => b.length), [100, 4]);
  assert.deepEqual(state.read().ids, ids);
  assert.equal(getFavoriteRooms([], ids, state.read().rooms).length, 105);
  assert.ok(state.read().rooms.every(r => r.status === 'unknown'));
});

test('old status expires without deleting metadata or asserting the room is offline', () => {
  const collection = { version: 2, ids: ['douyin-web-456'], rooms: [room] };
  assert.equal(expireFavoriteStatuses(collection, room.checkedAt + favoriteStatusMaxAgeMs - 1).rooms[0].status, 'live');
  const expired = expireFavoriteStatuses(collection, room.checkedAt + favoriteStatusMaxAgeMs);
  assert.equal(expired.rooms[0].status, 'unknown');
  assert.equal(expired.rooms[0].anchor, room.anchor);
  assert.equal(expired.rooms[0].checkedAt, room.checkedAt);
  assert.deepEqual(expired.ids, collection.ids);
});
