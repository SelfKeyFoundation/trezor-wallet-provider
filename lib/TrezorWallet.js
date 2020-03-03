"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = void 0;

var _ethereumjsTx = require("ethereumjs-tx");

var _ethereumjsUtil = require("ethereumjs-util");

var _bignumber = _interopRequireDefault(require("bignumber.js"));

var _promiseTimeout = require("promise-timeout");

var _hdkey = _interopRequireDefault(require("hdkey"));

var _msgConfig = _interopRequireDefault(require("./msg-config"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

const trezor = require('trezor.js');

let currentSession = null;
let currentDevice = null;
const hexPrefix = '0x';
const CUSTOM_TIME_OUT = 30000;
const hardeningConstant = 0x80000000;
const defaultAddress = [(44 | hardeningConstant) >>> 0, (60 | hardeningConstant) >>> 0, (0 | hardeningConstant) >>> 0, 0];
const deviceList = new trezor.DeviceList({
  config: _msgConfig.default
});
let wallets = [];

class TrezorWallet {
  constructor(networkId, accountsOffset = 0, accountsQuantity = 6, eventEmitter) {
    this.networkId = networkId; // Function which should return networkId

    this.getAccounts = this.getAccounts.bind(this);
    this.signTransaction = this.signTransaction.bind(this);
    this.accountsOffset = accountsOffset;
    this.accountsQuantity = accountsQuantity;
    this.eventEmitter = eventEmitter;
  }

  _addHexPrefix(val) {
    if (typeof val !== 'string') {
      return val;
    }

    return val.substring(0, 2) === hexPrefix ? val : hexPrefix + val;
  }

  _getAccountIndex(address) {
    return wallets.filter(wallet => {
      return wallet.address === address;
    })[0].index;
  }

  _getAddressByIndex(index) {
    return defaultAddress.concat([+index]);
  }

  _pinCallback(type, callback) {
    this.eventEmitter.off('ON_PIN', () => {});
    this.eventEmitter.on('ON_PIN', (err, enteredPin) => {
      callback(err, enteredPin);
    });
    this.eventEmitter.emit('TREZOR_PIN_REQUEST');
  }

  _passphraseCallback(callback) {
    this.eventEmitter.off('ON_PASSPHRASE', () => {});
    this.eventEmitter.on('ON_PASSPHRASE', (err, enteredPassphrase) => {
      callback(err, enteredPassphrase);
    });
    this.eventEmitter.emit('TREZOR_PASSPHRASE_REQUEST');
  }

  async _getCurrentSession() {
    if (!deviceList.transport) {
      throw new Error('TREZOR_BRIDGE_NOT_FOUND');
    }

    if (currentSession) {
      return currentSession;
    }

    if (currentDevice) {
      await currentDevice.steal();
    }

    const {
      device,
      session
    } = await deviceList.acquireFirstDevice(true);
    device.on('disconnect', () => {
      currentDevice = null;
      currentSession = null;
    });
    device.on('changedSessions', (isUsed, isUsedHere) => {
      if (isUsedHere) {
        currentSession = null;
      }
    });
    device.on('pin', this._pinCallback.bind(this));
    device.on('passphrase', this._passphraseCallback.bind(this));
    currentDevice = device;
    currentSession = session;
    return currentSession;
  }

  async signTransactionAsync(txData) {
    const accountIndex = this._getAccountIndex(txData.from);

    const txDataClone = { ...txData
    };
    Object.keys(txDataClone).forEach(key => {
      let val = txDataClone[key];
      val = val.replace(hexPrefix, '').toLowerCase();
      txDataClone[key] = val.length % 2 !== 0 ? `0${val}` : val;
    });
    let session = await this._getCurrentSession();
    let signPromise = session.signEthTx(this._getAddressByIndex(accountIndex), txDataClone.nonce, txDataClone.gasPrice, txDataClone.gas, txDataClone.to, txDataClone.value, txDataClone.data, this.networkId);
    let signed = null;

    try {
      signed = await (0, _promiseTimeout.timeout)(signPromise, CUSTOM_TIME_OUT);
    } catch (err) {
      if (err instanceof _promiseTimeout.TimeoutError) {
        currentSession = null;
      }

      throw err;
    }

    const signedTx = new _ethereumjsTx.Transaction({
      s: this._addHexPrefix(signed.s),
      v: this._addHexPrefix(new _bignumber.default(signed.v).toString(16)),
      r: this._addHexPrefix(signed.r.toString()),
      ...txData
    }, {
      chain: this.networkId
    });
    return hexPrefix + signedTx.serialize().toString('hex');
  }
  /**
     * Gets a list of accounts from a device - currently it's returning just
     * first one according to derivation path
     * @param {failableCallback} callback
     */


  async getAccounts(callback) {
    try {
      let session = await this._getCurrentSession();
      let addressN = {
        address_n: defaultAddress
      };
      let result = await session.typedCall('GetPublicKey', 'PublicKey', addressN);
      let chainCode = result.message.node.chain_code;
      let publicKey = result.message.node.public_key;
      let hdk = new _hdkey.default();
      hdk.publicKey = Buffer.from(publicKey, 'hex');
      hdk.chainCode = Buffer.from(chainCode, 'hex');
      let pathBase = 'm';
      let newWallets = [];
      let addresses = [];

      for (let i = 0; i < this.accountsQuantity; i++) {
        const index = i + this.accountsOffset;
        const dkey = hdk.derive(`${pathBase}/${index}`);
        const address = `0x${(0, _ethereumjsUtil.publicToAddress)(dkey.publicKey, true).toString('hex')}`;
        addresses.push(address);
        newWallets.push({
          address,
          index
        });
      }

      wallets = newWallets;
      callback(null, addresses);
    } catch (error) {
      callback(error, null);
    }
  }
  /**
     * Signs txData in a format that ethereumjs-tx accepts
     * @param {object} txData - transaction to sign
     * @param {failableCallback} callback - callback
     */


  signTransaction(txData, callback) {
    this.signTransactionAsync(txData).then(res => callback(null, res)).catch(err => callback(err, null));
  }

  async getPublicKey(address) {
    const accountIndex = this._getAccountIndex(address);

    const session = await this._getCurrentSession();
    let result = await session.typedCall('GetPublicKey', 'PublicKey', {
      address_n: this._getAddressByIndex(accountIndex)
    });
    return result.message.node.public_key;
  }

  async signPersonalMessage(address, message) {
    const accountIndex = this._getAccountIndex(address);

    const session = await this._getCurrentSession();
    return session.signEthMessage(this._getAddressByIndex(accountIndex), message);
  }

}

exports.default = TrezorWallet;