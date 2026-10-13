// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

interface IV2Router {
    function factory() external view returns (address);
    function WETH() external view returns (address);
    function getAmountsOut(uint256, address[] calldata) external view returns (uint256[] memory);
    function swapExactETHForTokens(uint256, address[] calldata, address, uint256)
        external
        payable
        returns (uint256[] memory);
}

interface IV2Factory {
    function getPair(address, address) external view returns (address);
}

/// Test-only bounded native-ETH -> allowlisted ERC20 route. Never takes user token allowances.
contract ZecOneSwapExecutor is EIP712, ReentrancyGuard {
    struct Intent {
        bytes32 action;
        bytes32 sourceNetwork;
        uint256 chainId;
        bytes32 orderId;
        bytes32 nonce;
        address recipient;
        address provider;
        bytes32 adapter;
        address target;
        uint256 maxNative;
        uint256 maxGas;
        uint256 zatoshis;
        uint64 expiry;
        bytes32 paramsHash;
        bytes32 calldataHash;
        bytes32 refundHash;
    }

    struct Swap {
        address inputAsset;
        uint256 amountIn;
        address outputToken;
        uint8 decimals;
        address router;
        bytes32 routeHash;
        uint256 expectedOut;
        uint256 minOut;
        uint256 slippageBps;
        uint64 deadline;
        uint256 referenceBlock;
        bytes32 referenceHash;
    }
    bytes32 constant TYPEHASH = keccak256(
        "ExecutionIntent(bytes32 action,bytes32 sourceNetwork,uint256 chainId,bytes32 orderId,bytes32 nonce,address recipient,address provider,bytes32 adapter,address target,uint256 maxNative,uint256 maxGas,uint256 zatoshis,uint64 expiry,bytes32 paramsHash,bytes32 calldataHash,bytes32 refundHash)"
    );
    bytes32 public constant ACTION = keccak256("TOKEN_SWAP");
    bytes32 public constant ADAPTER = keccak256("uniswap-v2-native-v1");
    uint256 public constant GAS_BUDGET = 0.0001 ether;
    uint256 public constant RATE = 0.02 ether; // Simulated test conversion, not an oracle.
    address public immutable relayer;
    IV2Router public immutable router;
    address public immutable weth;
    IERC20Metadata public immutable token;
    address public immutable pool;
    mapping(bytes32 => bool) public consumed;
    mapping(bytes32 => bool) public usedOrderIds;
    mapping(bytes32 => bool) public usedNonces;
    error InvalidIntent();
    error Replay();
    error Slippage();
    error ReceiptMismatch();
    event SwapExecuted(
        bytes32 indexed digest,
        address indexed recipient,
        address indexed token,
        uint256 amountIn,
        uint256 amountOut,
        uint256 balanceBefore,
        uint256 balanceAfter
    );

    constructor(address payer, IV2Router dex, IERC20Metadata output) EIP712("ZecOneExecution", "1") {
        if (
            block.chainid != 84532 || payer == address(0) || address(dex).code.length == 0
                || address(output).code.length == 0 || output.decimals() != 18
        ) revert InvalidIntent();
        relayer = payer;
        router = dex;
        token = output;
        weth = dex.WETH();
        pool = IV2Factory(dex.factory()).getPair(weth, address(output));
        if (pool.code.length == 0 || weth == address(output)) revert InvalidIntent();
    }

    function intentId(Intent calldata i) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(TYPEHASH, i)));
    }

    function execute(Intent calldata i, Swap calldata s, bytes calldata signature) external payable nonReentrant {
        if (
            block.chainid != 84532 || msg.sender != relayer || i.chainId != 84532 || i.provider != relayer
                || i.action != ACTION || i.adapter != ADAPTER || i.sourceNetwork != keccak256("zcash-testnet")
                || i.target != address(router) || i.orderId == 0 || i.nonce == 0 || i.recipient == address(0)
                || i.recipient == relayer || i.recipient == address(this) || i.recipient == pool
                || i.expiry <= block.timestamp || i.refundHash == 0
        ) revert InvalidIntent();
        address[] memory path = new address[](2);
        path[0] = weth;
        path[1] = address(token);
        if (
            s.inputAsset != weth || s.outputToken != address(token) || s.router != address(router) || s.decimals != 18
                || token.decimals() != 18 || s.amountIn == 0 || s.amountIn > 0.0002 ether || msg.value != s.amountIn
                || i.maxNative != s.amountIn || i.maxGas != GAS_BUDGET || tx.gasprice > 0.1 gwei
                || i.zatoshis != ((s.amountIn + GAS_BUDGET) * 1e8 + RATE - 1) / RATE || s.deadline != i.expiry
                || s.slippageBps == 0 || s.slippageBps > 300 || s.minOut == 0
                || s.minOut != s.expectedOut * (10000 - s.slippageBps) / 10000 || s.referenceBlock == 0
                || s.referenceHash == 0 || s.routeHash != keccak256(abi.encode(path))
                || i.paramsHash != keccak256(abi.encode(s))
                || i.calldataHash
                    != keccak256(
                        abi.encodeCall(router.swapExactETHForTokens, (s.minOut, path, i.recipient, s.deadline))
                    )
        ) revert InvalidIntent();
        bytes32 digest = intentId(i);
        if (consumed[digest] || usedOrderIds[i.orderId] || usedNonces[i.nonce]) revert Replay();
        if (ECDSA.recover(digest, signature) != i.recipient) revert InvalidIntent();
        if (router.getAmountsOut(s.amountIn, path)[1] < s.minOut) revert Slippage();
        consumed[digest] = true;
        usedOrderIds[i.orderId] = true;
        usedNonces[i.nonce] = true;
        uint256 beforeBalance = token.balanceOf(i.recipient);
        uint256[] memory amounts = router.swapExactETHForTokens{value: s.amountIn}(
            s.minOut, path, i.recipient, s.deadline
        );
        uint256 afterBalance = token.balanceOf(i.recipient);
        if (
            afterBalance < beforeBalance || afterBalance - beforeBalance < s.minOut
                || afterBalance - beforeBalance != amounts[1]
        ) revert ReceiptMismatch();
        emit SwapExecuted(digest, i.recipient, address(token), s.amountIn, amounts[1], beforeBalance, afterBalance);
    }
}
