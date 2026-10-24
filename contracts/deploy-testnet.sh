#!/usr/bin/env bash
# Deploy HerdLedger to a public testnet, verify the source on Sourcify, replay the demo subset of
# the pipeline seed and publish onchain.json + ABI to web/public/data.
#
#   ./deploy-testnet.sh                 # Base Sepolia  (default; chain 84532, gas in ETH)
#   ./deploy-testnet.sh base-sepolia    # same
#   ./deploy-testnet.sh amoy            # Polygon Amoy  (chain 80002, gas in POL)
#
# Reads PRIVATE_KEY (and optional overrides) from .env.testnet, or from ENV_FILE=<path>, or from
# the environment. The same key deploys, holds every role and signs as the oracle.
# Optional: RPC_URL (otherwise the public endpoint below), SEED (default ../pipeline/out/chain_seed.json),
# ETHERSCAN_API_KEY (adds Etherscan/Polygonscan/Basescan verification next to Sourcify),
# SKIP_VERIFY=1, MIN_PRIORITY_FEE_GWEI (Amoy, default 30).
set -euo pipefail
cd "$(dirname "$0")"

NET="${1:-base-sepolia}"
case "$NET" in
  amoy | polygon-amoy)
    CHAIN_ID=80002; SYMBOL=POL; DEFAULT_RPC="https://rpc-amoy.polygon.technology"
    EXPLORER="https://amoy.polygonscan.com"; FAUCET="https://faucet.polygon.technology"
    FEE_FLAGS=() ;;
  base-sepolia | base_sepolia)
    CHAIN_ID=84532; SYMBOL=ETH; DEFAULT_RPC="https://sepolia.base.org"
    EXPLORER="https://sepolia.basescan.org"; FAUCET="https://docs.base.org/base-chain/tools/network-faucets"
    FEE_FLAGS=() ;;
  *)
    echo "usage: $0 [base-sepolia|amoy]" >&2; exit 1 ;;
esac

ENV_FILE="${ENV_FILE:-.env.testnet}"
if [ -f "$ENV_FILE" ]; then
  set -a; # shellcheck disable=SC1090
  . "./$ENV_FILE"; set +a
fi
: "${PRIVATE_KEY:?PRIVATE_KEY is not set (put it in $ENV_FILE)}"
RPC_URL="${RPC_URL:-$DEFAULT_RPC}"
SEED="${SEED:-../pipeline/out/chain_seed.json}"
[ -f "$SEED" ] || SEED="test/fixtures/chain_seed.sample.json"

BIN="$(pwd)/.tools/bin"
if [ -x "$BIN/forge" ] || [ -x "$BIN/forge.exe" ]; then export PATH="$BIN:$PATH"; fi
command -v forge >/dev/null || { echo "forge not found (see README: install Foundry)" >&2; exit 1; }
[ -d node_modules/ethers ] || npm install --no-audit --no-fund

# ------------------------------------------------------------------ preflight
ACTUAL_CHAIN="$(cast chain-id --rpc-url "$RPC_URL")"
[ "$ACTUAL_CHAIN" = "$CHAIN_ID" ] || { echo "RPC $RPC_URL is chain $ACTUAL_CHAIN, expected $CHAIN_ID" >&2; exit 1; }
DEPLOYER="$(cast wallet address --private-key "$PRIVATE_KEY")"
BALANCE_WEI="$(cast balance "$DEPLOYER" --rpc-url "$RPC_URL")"
GAS_PRICE_WEI="$(cast gas-price --rpc-url "$RPC_URL")"
# Measured on a local rehearsal: deploy + role grants ~6.4M gas, subset replay ~9.5M gas (67 txs).
GAS_EXPECTED="${GAS_EXPECTED:-16500000}"
TIP_WEI=0
if [ "$CHAIN_ID" = "80002" ]; then TIP_WEI="$(node -e "console.log((BigInt('${MIN_PRIORITY_FEE_GWEI:-30}')*10n**9n).toString())")"; fi
MAX_FEE_WEI="$(node -e "console.log((2n*BigInt('$GAS_PRICE_WEI')+BigInt('$TIP_WEI')).toString())")"
# Expected spend: gas x (current price + tip) + 20 % margin; Base adds a small L1 data fee per tx.
L1_ALLOWANCE_WEI=0; [ "$CHAIN_ID" = "84532" ] && L1_ALLOWANCE_WEI=20000000000000
NEED_WEI="$(node -e "const p=BigInt('$GAS_PRICE_WEI')+BigInt('$TIP_WEI');console.log((p*BigInt($GAS_EXPECTED)*12n/10n+BigInt('$L1_ALLOWANCE_WEI')).toString())")"
WORST_WEI="$(node -e "console.log((BigInt('$MAX_FEE_WEI')*BigInt($GAS_EXPECTED)+BigInt('$L1_ALLOWANCE_WEI')).toString())")"
if [ "$CHAIN_ID" = "80002" ]; then
  FEE_FLAGS=(--priority-gas-price "$TIP_WEI" --with-gas-price "$MAX_FEE_WEI")
fi
echo "network   $NET (chain $CHAIN_ID) via $RPC_URL"
echo "deployer  $DEPLOYER  balance $(cast from-wei "$BALANCE_WEI") $SYMBOL"
echo "estimate  ~${GAS_EXPECTED} gas total (deploy ~6.4M + subset replay ~9.5M) at $(cast from-wei "$GAS_PRICE_WEI" gwei) gwei"
echo "          expected cost ~$(cast from-wei "$NEED_WEI") $SYMBOL, worst case $(cast from-wei "$WORST_WEI") $SYMBOL"
ENOUGH="$(node -e "console.log(BigInt('$BALANCE_WEI') >= BigInt('$NEED_WEI') ? 'yes' : 'no')")"
if [ "$ENOUGH" != "yes" ]; then
  echo "insufficient funds: send at least $(cast from-wei "$NEED_WEI") $SYMBOL to $DEPLOYER ($FAUCET)" >&2
  exit 1
fi

# ------------------------------------------------------------------ deploy
forge build
forge script script/Deploy.s.sol --rpc-url "$RPC_URL" --broadcast --slow "${FEE_FLAGS[@]}"
ADDRESS="$(node -e "
  const b=require('./broadcast/Deploy.s.sol/$CHAIN_ID/run-latest.json');
  console.log(b.transactions.find(t=>t.transactionType==='CREATE'&&t.contractName==='HerdLedger').contractAddress)")"
echo "HerdLedger $ADDRESS  ($EXPLORER/address/$ADDRESS)"

# ------------------------------------------------------------------ verify (never blocks the replay)
if [ "${SKIP_VERIFY:-0}" != "1" ]; then
  ARGS="$(cast abi-encode 'constructor(address)' "$DEPLOYER")"
  forge verify-contract "$ADDRESS" src/HerdLedger.sol:HerdLedger --chain "$CHAIN_ID" \
    --verifier sourcify --constructor-args "$ARGS" --watch || echo "warning: Sourcify verification failed (retry later, see README)"
  if [ -n "${ETHERSCAN_API_KEY:-}" ]; then
    forge verify-contract "$ADDRESS" src/HerdLedger.sol:HerdLedger --chain "$CHAIN_ID" \
      --verifier etherscan --etherscan-api-key "$ETHERSCAN_API_KEY" --constructor-args "$ARGS" --watch \
      || echo "warning: Etherscan verification failed (retry later, see README)"
  fi
fi

# ------------------------------------------------------------------ replay the demo subset
ENV_ARGS=(); [ -f "$ENV_FILE" ] && ENV_ARGS=(--env-file "$ENV_FILE")
node replay/replay.mjs "$SEED" --subset --rpc "$RPC_URL" --address "$ADDRESS" "${ENV_ARGS[@]}"
echo "done: $EXPLORER/address/$ADDRESS"
