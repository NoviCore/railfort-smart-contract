require('dotenv').config();

module.exports = {
  networks: {
    mainnet: {
      privateKey: process.env.PRIVATE_KEY_MAINNET,
      userFeePercentage: 100,
      feeLimit: 1000 * 1e6,
      fullHost: process.env.MAINNET_RPC_URL || 'https://api.trongrid.io',
      network_id: '1',
    },
    shasta: {
      privateKey: process.env.PRIVATE_KEY_SHASTA,
      userFeePercentage: 50,
      feeLimit: 1000 * 1e6,
      fullHost: 'https://api.shasta.trongrid.io',
      network_id: '2',
    },
    nile: {
      privateKey: process.env.PRIVATE_KEY_NILE,
      userFeePercentage: 100,
      feeLimit: 1000 * 1e6,
      fullHost: 'https://nile.trongrid.io',
      network_id: '3',
    },
    development: {
      // Local: start Docker quickstart on :9090, proxy on :9091 (npm run node:proxy)
      privateKey: 'da146374a75310b9666e834ee4ad0866d6f4035967bfc76217c5a495fff9f0d0',
      userFeePercentage: 0,
      feeLimit: 1000 * 1e6,
      fullHost: 'http://127.0.0.1:9091',
      network_id: '*',
    },
  },
  compilers: {
    solc: {
      version: '0.8.26',
      settings: {
        optimizer: {
          enabled: true,
          runs: 200,
        },
        viaIR: true,
        // "london" prevents PUSH0 (Shanghai opcode) so bytecode runs on the local quickstart TVM
        evmVersion: 'london',
      },
    },
  },
};
