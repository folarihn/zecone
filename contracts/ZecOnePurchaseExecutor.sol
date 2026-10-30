// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {TestMarketplace} from "./TestMarketplace.sol";

contract ZecOnePurchaseExecutor is EIP712, ReentrancyGuard {
    struct Quote {
        bytes32 orderId;
        uint256 chainId;
        address marketplace;
        uint256 listingId;
        address nft;
        uint256 tokenId;
        address seller;
        address recipient;
        uint256 price;
        uint256 gasBudget;
        uint256 zatoshis;
        uint256 rate;
        uint256 maxSlippageBps;
        uint64 expiry;
        bytes32 calldataHash;
        bytes32 refundHash;
        bytes32 originHash;
    }
    bytes32 constant TYPEHASH = keccak256(
        "PurchaseQuote(bytes32 orderId,uint256 chainId,address marketplace,uint256 listingId,address nft,uint256 tokenId,address seller,address recipient,uint256 price,uint256 gasBudget,uint256 zatoshis,uint256 rate,uint256 maxSlippageBps,uint64 expiry,bytes32 calldataHash,bytes32 refundHash,bytes32 originHash)"
    );
    uint256 public constant RATE = 0.02 ether;
    uint256 public constant GAS_BUDGET = 0.0001 ether;
    uint256 public constant MAX_PRICE = 0.001 ether;
    address public immutable relayer;
    TestMarketplace public immutable marketplace;
    mapping(bytes32 => bool) public consumed;
    mapping(bytes32 => bool) public usedOrderIds;
    error TestnetOnly();
    error Unauthorized();
    error InvalidQuote();
    error ListingChanged();
    error Replay();
    error OwnershipMismatch();
    event PurchaseExecuted(
        bytes32 indexed digest,
        uint256 indexed listingId,
        address indexed recipient,
        address nft,
        uint256 tokenId,
        uint256 price
    );

    constructor(address payer, TestMarketplace market) EIP712("ZecOneMarketplace", "1") {
        if (block.chainid != 84532) revert TestnetOnly();
        if (payer == address(0) || address(market).code.length == 0) revert InvalidQuote();
        relayer = payer;
        marketplace = market;
    }

    function quoteId(Quote calldata q) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(TYPEHASH, q)));
    }

    function execute(Quote calldata q, bytes calldata signature) external payable nonReentrant {
        if (block.chainid != 84532) revert TestnetOnly();
        if (msg.sender != relayer) revert Unauthorized();
        if (
            q.chainId != 84532 || q.marketplace != address(marketplace) || q.orderId == bytes32(0)
                || q.expiry <= block.timestamp || q.recipient == address(0) || q.recipient == relayer
                || q.recipient == q.seller || q.price == 0 || q.price > MAX_PRICE || msg.value != q.price
                || q.gasBudget != GAS_BUDGET || q.rate != RATE || q.maxSlippageBps != 0
                || q.zatoshis != ((q.price + GAS_BUDGET) * 1e8 + RATE - 1) / RATE || q.refundHash == bytes32(0)
                || q.originHash == bytes32(0)
                || q.calldataHash != keccak256(abi.encodeCall(marketplace.buy, (q.listingId, q.recipient)))
                || tx.gasprice > 100_000_000
        ) revert InvalidQuote();
        bytes32 id = quoteId(q);
        if (consumed[id] || usedOrderIds[q.orderId]) revert Replay();
        if (ECDSA.recover(id, signature) != q.recipient) revert InvalidQuote();
        TestMarketplace.Listing memory l = marketplace.getListing(q.listingId);
        if (
            l.nft != q.nft || l.tokenId != q.tokenId || l.seller != q.seller || l.price != q.price
                || l.expiry < q.expiry || !marketplace.valid(q.listingId)
        ) revert ListingChanged();
        consumed[id] = true;
        usedOrderIds[q.orderId] = true;
        marketplace.buy{value: q.price}(q.listingId, q.recipient);
        if (IERC721(q.nft).ownerOf(q.tokenId) != q.recipient) revert OwnershipMismatch();
        emit PurchaseExecuted(id, q.listingId, q.recipient, q.nft, q.tokenId, q.price);
    }
}
