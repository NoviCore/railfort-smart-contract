/**
 * Shared test helpers.
 * Uses the subset of ethersUtils actually exposed by TronWeb 4.8's bundled ethers.
 */

require('dotenv').config();
const { TronWeb } = require('tronweb');

// Single utility TronWeb instance (no key needed for address/utils work)
const tw = new TronWeb({ fullHost: 'https://nile.trongrid.io' });
const { SigningKey, keccak256, arrayify, concat, toUtf8Bytes } = tw.utils.ethersUtils;

// ─── Address helpers ─────────────────────────────────────────────────────────

// Any address format → lowercase 20-byte hex with 0x prefix
function toEthHex(addr) {
  if (!addr) return addr;
  const s = addr.toString();
  if (s.startsWith('T') || /^[A-Z2-9]{34}$/i.test(s)) {
    return '0x' + TronWeb.address.toHex(s).slice(2).toLowerCase();
  }
  if (s.startsWith('41') && s.length === 42) return '0x' + s.slice(2).toLowerCase();
  if (s.startsWith('0x'))                     return s.toLowerCase();
  return '0x' + s.toLowerCase();
}

function privateKeyToTronAddr(hex) {
  return tw.address.fromPrivateKey(hex);
}

// Any BigNumber / bigint / number → plain JS number
function n(x) {
  if (typeof x === 'bigint')                   return Number(x);
  if (x && typeof x.toNumber === 'function')   return x.toNumber();
  return Number(x);
}

// ─── Signing ─────────────────────────────────────────────────────────────────

// Manually packs (address, address, uint256, uint256) — matches abi.encodePacked
function _packPayload(contractAddr, recipient, amount, nonce) {
  const buf = Buffer.alloc(104); // 20+20+32+32
  Buffer.from(toEthHex(contractAddr).slice(2), 'hex').copy(buf, 0);
  Buffer.from(toEthHex(recipient).slice(2),    'hex').copy(buf, 20);
  const a = BigInt(amount);
  const no = BigInt(nonce);
  for (let i = 0; i < 32; i++) {
    buf[40 + 31 - i] = Number((a  >> BigInt(i * 8)) & 0xffn);
    buf[72 + 31 - i] = Number((no >> BigInt(i * 8)) & 0xffn);
  }
  return '0x' + buf.toString('hex');
}

// Reproduces SpendingManager._buildMessageHash():
//   keccak256("\x19Ethereum Signed Message:\n32" + keccak256(abi.encodePacked(contractAddress, recipient, amount, nonce)))
// EIP-191 personal-sign prefix — matches TronLink's signMessageV2().
function buildMsgHash(contractAddr, recipient, amount, nonce) {
  const rawHash = keccak256(_packPayload(contractAddr, recipient, amount, nonce));
  const prefix  = toUtf8Bytes('\x19Ethereum Signed Message:\n32');
  return keccak256(concat([prefix, arrayify(rawHash)]));
}

// Returns a 65-byte hex signature (with 0x prefix)
function signTransfer(contractAddr, recipient, amount, nonce, privateKeyHex) {
  const msgHash = buildMsgHash(contractAddr, recipient, amount, nonce);
  const sig = new SigningKey('0x' + privateKeyHex).sign(msgHash);
  return sig.serialized;
}

// Zero address in TRON base58
const ZERO_ADDR = TronWeb.address.fromHex('410000000000000000000000000000000000000000');

// ─── Local quickstart key lookup ─────────────────────────────────────────────

// The trontools/quickstart node generates random accounts on each start.
// Query its admin API to find the private key for a given TRON address.
function fetchQuickstartKey(tronAddr) {
  return new Promise((resolve) => {
    const http = require('http');
    http.get('http://127.0.0.1:9090/admin/accounts', (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        const lines = data.split('\n');
        const target = toEthHex(tronAddr).toLowerCase();
        let idx = -1;
        for (const line of lines) {
          const m = line.match(/^\((\d+)\)\s+(\S+)/);
          if (m && toEthHex(m[2]).toLowerCase() === target) {
            idx = parseInt(m[1]);
            break;
          }
        }
        if (idx === -1) return resolve(null);
        const keyLine = lines.find(l => new RegExp(`^\\(${idx}\\)\\s+[0-9a-f]{64}`).test(l));
        resolve(keyLine ? keyLine.match(/([0-9a-f]{64})/)[1] : null);
      });
    }).on('error', () => resolve(null));
  });
}

// ─── Retry helper ────────────────────────────────────────────────────────────

// Retries a TronBox/TronWeb call on transient quickstart node errors.
//
// Known transient errors:
//   SERVER_BUSY              — node rejected the broadcast under rapid load
//   No contract or not a ... — node briefly couldn't verify the contract address
//
// A short back-off (1.5 s) is enough for the quickstart to catch up.
async function withRetry(fn, maxAttempts = 4, delayMs = 1500) {
    for (let i = 0; i < maxAttempts; i++) {
        try {
            return await fn();
        } catch (e) {
            const msg = (e && typeof e.message === 'string') ? e.message : '';
            const transient =
                msg.includes('SERVER_BUSY') ||
                msg.includes('No contract or not a smart contract');
            if (transient && i < maxAttempts - 1) {
                await new Promise(r => setTimeout(r, delayMs));
                continue;
            }
            throw e;
        }
    }
}

module.exports = { toEthHex, privateKeyToTronAddr, n, signTransfer, ZERO_ADDR, fetchQuickstartKey, withRetry };
