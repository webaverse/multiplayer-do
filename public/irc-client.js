import { zbclone } from './encoding.mjs';
import {UPDATE_METHODS} from './update-types.js';
import {parseUpdateObject, makeId} from './util.mjs';

export class IrcPlayer extends EventTarget {
  constructor() {
    super();
  }
}

export class NetworkedIrcClient extends EventTarget {
  constructor(ws) {
    super();
    this.ws = ws;
    this.playerId = makeId();
  }
  static handlesMethod(method) {
    return [
      UPDATE_METHODS.NETWORK_INIT,
      UPDATE_METHODS.JOIN,
      UPDATE_METHODS.LEAVE,
      UPDATE_METHODS.CHAT,
    ].includes(method);
  }
  async connect() {
    await new Promise((resolve, reject) => {
      resolve = (resolve => () => {
        resolve();
        _cleanup();
      })(resolve);
      reject = (reject => () => {
        reject();
        _cleanup();
      })(reject);
      
      this.ws.addEventListener('open', resolve);
      this.ws.addEventListener('error', reject);

      const _cleanup = () => {
        this.ws.removeEventListener('open', resolve);
        this.ws.removeEventListener('error', reject);
      };
    });

    // console.log('irc listen');
    this.ws.addEventListener('message', e => {
      if (e.data instanceof ArrayBuffer) {
        const updateBuffer = e.data;
        // console.log('irc data', e.data);
        const uint8Array = new Uint8Array(updateBuffer);
        const updateObject = parseUpdateObject(uint8Array);

        const {method, args} = updateObject;
        // console.log('irc handles method', method, NetworkedIrcClient.handlesMethod(method));
        if (NetworkedIrcClient.handlesMethod(method)) {
          this.handleUpdateObject(updateObject);
        }
      }
    });
  }
  handleUpdateObject(updateObject) {
    const {method, args} = updateObject;
    // console.log('got irc', {method, args});
    if (method === UPDATE_METHODS.CHAT) {
      // console.log('got irc chat', {method, args});
      const chatMessage = new MessageEvent('chat', {
        data: args,
      });
      this.dispatchEvent(chatMessage);
    } else {
      console.warn('unhandled irc method', {method, args});
    }
  }
  sendChatMessage(message) {
    const buffer = zbencode({
      method: UPDATE_METHODS.CHAT,
      args: {
        playerId: this.playerId,
        message,
      },
    });
    this.ws.send(buffer);
  }
}