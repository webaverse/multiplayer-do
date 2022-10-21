import {DataClient, NetworkedDataClient, DCMap, DCArray} from './data-client.mjs';
import {createWs} from './util.mjs';

const arrayEquals = (a, b) => {
  if (a.length !== b.length) {
    return false;
  } else {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        return false;
      }
    }
    return true;
  }
};
const makePromise = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  promise.resolve = resolve;
  promise.reject = reject;
  return promise;
}
const makeTransactionHandler = () => {
  let running = false;
  const queue = [];
  async function handle(fn) {
    if (!running) {
      running = true;
      let result;
      let error;
      try {
        result = await fn();
      } catch (err) {
        error = err;
      }
      running = false;
      if (queue.length > 0) {
        queue.shift()();
      }
      if (!error) {
        return result;
      } else {
        throw error;
      }
    } else {
      const promise = makePromise();
      queue.push(promise.resolve);
      await promise;
      return handle(fn);
    }
  }
  return handle;
};

//

class VirtualPlayersArray extends EventTarget {
  
}

//

class VirtualEntityMap extends EventTarget {
  constructor(arrayIndexId, virtualArray) {
    this.arrayIndexId = arrayIndexId;
    this.virtualArray = virtualArray;
  }
  link(networkedDataClient, map) {
    // listen for map update events
    map.addEventListener('update', e => {
      const {
        key,
        epoch,
        val,
      } = e.data;
      // XXX only handle if this is the king data client
    });
  }
  unlink() {

  }
}

class VirtualEntityArray extends EventTarget {
  constructor(arrayId, parent) {
    super();

    this.arrayId = arrayId;
    this.parent = parent;

    this.virtualMaps = new Map();
    this.dcCleanupFns = new Map();
  }
  addEntity(val) {
    // XXX add to the dynamically computed center realm based on position
    const {centerRealm} = this.parent;
    const {
      map,
      update,
    } = centerRealm.dataClient.add(val);
    centerRealm.dataClient.emitUpdate(update);
    return map;
  }
  getOrCreateVirtualMap(arrayIndexId) {
    let virtualMap = this.virtualMaps.get(arrayIndexId);
    if (!virtualMap) {
      virtualMap = new VirtualEntityMap(arrayIndexId, this);
      this.virtualMaps.set(arrayIndexId, virtualMap);
    
      this.dispatchEvent(new MessageEvent('entityadd', {
        data: {
          id: arrayIndexId,
          entity: virtualMap,
        },
      }));

      virtualMap.addEventListener('garbagecollect', e => {
        this.dispatchEvent(new MessageEvent('entityremove', {
          data: {
            arrayIndexId,
          },
        }));
      });
    }
    return virtualMap;
  }
  link(networkedDataClient) {
    // bind local array maps to virutal maps
    const dcArray = networkedDataClient.dataClient.getArray(this.arrayId);
    const localVirtualMaps = new Map();
    dcArray.addEventListener('add', e => {
      const {arrayIndexId, map} = e.data;
      const virtualMap = this.getOrCreateVirtualMap(arrayIndexId);
      virtualMap.link(map);
      localVirtualMaps.set(map, virtualMap);
    });
    dcArray.addEventListener('remove', e => {
      const {arrayIndexId} = e.data;
      const virtualMap = this.virtualMaps.get(arrayIndexId);
      virtualMap.unlink(arrayIndexId);
      localVirtualMaps.delete(arrayIndexId);
    });
    
    this.dcCleanupFns.set(networkedDataClient, () => {
      dcArray.unlisten();
      for (const localVirtualMap of localVirtualMaps.values()) {
        localVirtualMap.unlink(networkedDataClient);
      }
    });
  }
  unlink(networkedDataClient) {
    this.dcCleanupFns.get(networkedDataClient)();
    this.dcCleanupFns.delete(networkedDataClient);
  }
}

//

export class NetworkRealm {
  constructor(min, size, parent) {
    this.min = min;
    this.size = size;
    this.parent = parent;

    this.key = min.join(':');
    
    this.ws = null;
    this.dataClient = null;
    this.networkedDataClient = null;
  }
  async connect() {
    const dc1 = new DataClient({
      crdt: new Map(),
    });
    const ws1 = createWs('realm:' + this.key, this.parent.playerId);
    ws1.binaryType = 'arraybuffer';
    const ndc1 = new NetworkedDataClient(dc1, ws1);

    this.ws = ws1;
    this.dataClient = dc1;
    this.networkedDataClient = ndc1;

    await this.networkedDataClient.connect();
  }
  disconnect() {
    console.warn('disconnect');
    this.ws.close();
  }
}

//

export class NetworkRealms extends EventTarget {
  constructor(playerId) {
    super();

    this.playerId = playerId;

    this.lastPosition = [NaN, NaN, NaN];
    this.players = new VirtualPlayersArray();
    this.world = new VirtualEntityArray('world', this);
    this.connectedRealms = new Set();
    this.centerRealm = null;
    this.tx = makeTransactionHandler();
  }
  getVirtualPlayers() {
    return this.players;
  }
  getVirtualWorld() {
    return this.world;
  }
  async updatePosition(position, realmSize) {
    const snappedPosition = position.map(v => Math.floor(v / realmSize) * realmSize);
    if (!arrayEquals(snappedPosition, this.lastPosition)) {
      this.lastPosition[0] = snappedPosition[0];
      this.lastPosition[1] = snappedPosition[1];
      this.lastPosition[2] = snappedPosition[2];

      await this.tx(async () => {
        const candidateRealms = [];
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const min = [
              Math.floor((snappedPosition[0] + dx * realmSize) / realmSize) * realmSize,
              0,
              Math.floor((snappedPosition[2] + dz * realmSize) / realmSize) * realmSize,
            ];
            const realm = new NetworkRealm(min, realmSize, this);
            candidateRealms.push(realm);
          }
        }

        // check if we need to connect to new realms
        const connectPromises = [];
        for (const realm of candidateRealms) {
          let foundRealm = null;
          for (const connectedRealm of this.connectedRealms) {
            if (connectedRealm.key === realm.key) {
              foundRealm = connectedRealm;
              break;
            }
          }

          if (foundRealm) {
            if (arrayEquals(foundRealm.min, snappedPosition)) {
              this.centerRealm = foundRealm;
            }
          } else {
            this.dispatchEvent(new MessageEvent('realmconnecting', {
              data: {
                realm,
              },
            }));

            const connectPromise = (async () => {
              await realm.connect();
              this.connectedRealms.add(realm);
              if (arrayEquals(realm.min, snappedPosition)) {
                this.centerRealm = realm;
              }
              this.world.link(realm.networkedDataClient);
              this.dispatchEvent(new MessageEvent('realmjoin', {
                data: {
                  realm,
                },
              }));
            })();
            connectPromises.push(connectPromise);
          }
        }
        await Promise.all(connectPromises);

        // check if we need to disconnect from any realms
        const oldRealms = [];
        for (const connectedRealm of this.connectedRealms) {
          if (!candidateRealms.find(candidateRealm => candidateRealm.key === connectedRealm.key)) {
            this.world.unlink(connectedRealm.networkedDataClient);
            connectedRealm.disconnect();
            this.connectedRealms.delete(connectedRealm);
            oldRealms.push(connectedRealm);
          }
        }
        for (const oldRealm of oldRealms) {
          this.dispatchEvent(new MessageEvent('realmleave', {
            data: {
              realm: oldRealm,
            },
          }));
        }
      });
    }
  }
}