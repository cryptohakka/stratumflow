require('dotenv').config({ path: '../.env' });
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const solc = require('solc');

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || 'https://rpc.mantle.xyz');
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  console.log('Deploying from:', wallet.address);
  console.log('Network: Mantle Mainnet');

  const src = fs.readFileSync(path.join(__dirname, 'RebalanceRecorder.sol'), 'utf8');
  const input = {
    language: 'Solidity',
    sources: { 'RebalanceRecorder.sol': { content: src } },
    settings: { outputSelection: { '*': { '*': ['abi', 'evm.bytecode'] } } }
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  if (output.errors?.some(e => e.severity === 'error')) {
    console.error(output.errors); process.exit(1);
  }
  const contract = output.contracts['RebalanceRecorder.sol']['RebalanceRecorder'];
  const abi = contract.abi;
  const bytecode = contract.evm.bytecode.object;

  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  console.log('Deploying...');
  const deployed = await factory.deploy();
  await deployed.waitForDeployment();
  const address = await deployed.getAddress();
  console.log('✅ RebalanceRecorder deployed:', address);

  fs.writeFileSync(path.join(__dirname, 'deployed.json'), JSON.stringify({ address, abi }, null, 2));
  console.log('Saved to deployed.json');
}

main().catch(console.error);
