const fs = require('fs');
let code = fs.readFileSync('src/streams.ts', 'utf8');

// 1. Add token resolution logic inside StreamsModule.create()
const resolveLogic = `
    const now = Math.floor(Date.now() / 1000);
    if (startTime !== undefined && startTime < now) {
      throw new Error('Invalid startTime: cannot be in the past');
    }

    let resolvedToken = token;
    if (token === 'native') {
      resolvedToken = Asset.native().contractId(this.passphrase);
    } else if (token === 'USDC') {
      if (this.passphrase.includes('Test SDF Network')) {
        resolvedToken = new Asset('USDC', 'GBBD47IF6LWK7P7MDEVSCWTTCJM4TWCHZR4TCEFUB8IQVGIGY4MBKOMZ').contractId(this.passphrase);
      } else {
        resolvedToken = new Asset('USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5REANYOUR').contractId(this.passphrase);
      }
    }

    // Query token decimals
    const decimals = await getTokenDecimals(this.rpcUrl, this.passphrase, senderAddr, resolvedToken);
`;

code = code.replace(
  /\/\/ Query token decimals\s+const decimals = await getTokenDecimals\(this.rpcUrl, this.passphrase, senderAddr, token\);/g,
  resolveLogic
);

// 2. Also need to replace `new Address(token).toScVal()` with `new Address(resolvedToken).toScVal()`
// Wait, the arguments are built manually:
// new Address(senderAddr).toScVal(),
// new Address(recipient).toScVal(),
// new Address(token).toScVal(),
code = code.replace(
  /new Address\(token\)\.toScVal\(\),/g,
  'new Address(resolvedToken).toScVal(),'
);

// Add Asset import if not there
if (!code.includes('Asset,')) {
  code = code.replace(/import { SorobanRpc, nativeToScVal, xdr, Address, Transaction, BASE_FEE } from '@stellar\/stellar-sdk';/,
    "import { SorobanRpc, nativeToScVal, xdr, Address, Transaction, BASE_FEE, Asset } from '@stellar/stellar-sdk';");
}

fs.writeFileSync('src/streams.ts', code);
