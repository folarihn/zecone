// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SeaportInterface} from "seaport-types/src/interfaces/SeaportInterface.sol";
import {
    AdvancedOrder,
    OrderParameters,
    OrderComponents,
    CriteriaResolver,
    ConsiderationItem
} from "seaport-types/src/lib/ConsiderationStructs.sol";
import {ItemType, OrderType} from "seaport-types/src/lib/ConsiderationEnums.sol";

/// A narrow adapter to the existing public Seaport 1.6. Never holds the purchased NFT.
contract ZecOneSeaportExecutor is EIP712, ReentrancyGuard {
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

    struct Listing {
        bytes32 orderHash;
        uint256 tokenId;
        uint256 sellerAmount;
        uint256 fee;
    }
    bytes32 constant TYPEHASH = keccak256(
        "ExecutionIntent(bytes32 action,bytes32 sourceNetwork,uint256 chainId,bytes32 orderId,bytes32 nonce,address recipient,address provider,bytes32 adapter,address target,uint256 maxNative,uint256 maxGas,uint256 zatoshis,uint64 expiry,bytes32 paramsHash,bytes32 calldataHash,bytes32 refundHash)"
    );
    address public constant SEAPORT = 0x0000000000000068F116a894984e2DB1123eB395;
    bytes32 public constant PROTOCOL_CODE = 0x7912af42062ec0080cde88360c1429d58984ae16eb3f17af505b815bf6ffc745;
    uint256 public constant GAS_BUDGET = 0.0001 ether;
    address public immutable relayer;
    IERC721 public immutable nft;
    address public immutable seller;
    address public immutable feeRecipient;
    mapping(bytes32 => bool) public consumed;
    mapping(bytes32 => bool) public usedOrderIds;
    mapping(bytes32 => bool) public usedNonces;
    error InvalidIntent();
    error Replay();
    error InvalidListing();
    error DeliveryMismatch();
    event SeaportPurchased(
        bytes32 indexed digest,
        bytes32 indexed seaportOrderHash,
        address indexed recipient,
        address nft,
        uint256 tokenId,
        address seller,
        uint256 sellerAmount,
        address feeRecipient,
        uint256 feeAmount
    );

    constructor(address payer, IERC721 collection, address offerer, address feeReceiver) EIP712("ZecOneSeaport", "1") {
        if (
            block.chainid != 84532 || SEAPORT.codehash != PROTOCOL_CODE || payer == address(0)
                || address(collection).code.length == 0 || offerer == address(0) || offerer == payer
                || feeReceiver == offerer
        ) revert InvalidIntent();
        (string memory version,,) = SeaportInterface(SEAPORT).information();
        if (keccak256(bytes(version)) != keccak256("1.6")) revert InvalidIntent();
        relayer = payer;
        nft = collection;
        seller = offerer;
        feeRecipient = feeReceiver;
    }

    function intentId(Intent calldata i) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(TYPEHASH, i)));
    }

    function execute(Intent calldata i, AdvancedOrder calldata a, uint256 counter, bytes calldata signature)
        external
        payable
        nonReentrant
    {
        bytes32 digest = intentId(i);
        if (consumed[digest] || usedOrderIds[i.orderId] || usedNonces[i.nonce]) revert Replay();
        if (
            block.chainid != 84532 || SEAPORT.codehash != PROTOCOL_CODE || msg.sender != relayer
                || i.provider != relayer || i.chainId != 84532 || i.target != SEAPORT
                || i.action != keccak256("SEAPORT_PURCHASE") || i.adapter != keccak256("seaport-1.6-full-open-v1")
                || i.sourceNetwork != keccak256("zcash-testnet") || i.recipient == address(0) || i.recipient == relayer
                || i.recipient == seller || i.orderId == 0 || i.nonce == 0 || i.refundHash == 0
                || i.expiry <= block.timestamp || i.maxNative == 0 || i.maxNative > 0.0002 ether
                || msg.value != i.maxNative || i.maxGas != GAS_BUDGET || tx.gasprice > 0.1 gwei
                || i.zatoshis != ((i.maxNative + GAS_BUDGET) * 1e8 + 0.02 ether - 1) / 0.02 ether
        ) revert InvalidIntent();
        Listing memory listing = validateListing(i, a, counter);
        CriteriaResolver[] memory criteria = new CriteriaResolver[](0);
        if (
            i.calldataHash
                != keccak256(
                    abi.encodeCall(SeaportInterface.fulfillAdvancedOrder, (a, criteria, bytes32(0), i.recipient))
                )
        ) revert InvalidIntent();
        if (ECDSA.recover(digest, signature) != i.recipient) revert InvalidIntent();
        if (nft.ownerOf(listing.tokenId) != seller) revert InvalidListing();
        consumed[digest] = true;
        usedOrderIds[i.orderId] = true;
        usedNonces[i.nonce] = true;
        fulfill(i, a, listing);
        emit SeaportPurchased(
            digest,
            listing.orderHash,
            i.recipient,
            address(nft),
            listing.tokenId,
            seller,
            listing.sellerAmount,
            feeRecipient,
            listing.fee
        );
    }

    function fulfill(Intent calldata i, AdvancedOrder calldata a, Listing memory listing) private {
        if (seller.code.length != 0 || feeRecipient.code.length != 0) revert InvalidListing();
        uint256 sellerBefore = seller.balance;
        uint256 feeBefore = feeRecipient.balance;
        if (
            !SeaportInterface(SEAPORT).fulfillAdvancedOrder{value: i.maxNative}(
                    a, new CriteriaResolver[](0), bytes32(0), i.recipient
                ) || nft.ownerOf(listing.tokenId) != i.recipient
                || seller.balance != sellerBefore + listing.sellerAmount
                || (listing.fee > 0 && feeRecipient.balance != feeBefore + listing.fee)
        ) revert DeliveryMismatch();
    }

    function validateListing(Intent calldata i, AdvancedOrder calldata a, uint256 counter)
        private
        view
        returns (Listing memory listing)
    {
        OrderParameters calldata p = a.parameters;
        if (
            p.offerer != seller || p.zone != address(0) || p.zoneHash != 0 || p.conduitKey != 0
                || p.orderType != OrderType.FULL_OPEN || p.offer.length != 1 || p.consideration.length < 1
                || p.consideration.length > 2 || p.totalOriginalConsiderationItems != p.consideration.length
                || a.numerator != 1 || a.denominator != 1 || a.extraData.length != 0 || p.startTime > block.timestamp
                || p.endTime <= i.expiry || counter != SeaportInterface(SEAPORT).getCounter(seller)
        ) revert InvalidListing();
        if (
            p.offer[0].itemType != ItemType.ERC721 || p.offer[0].token != address(nft) || p.offer[0].startAmount != 1
                || p.offer[0].endAmount != 1
        ) revert InvalidListing();
        uint256 total;
        for (uint256 n; n < p.consideration.length; n++) {
            ConsiderationItem calldata item = p.consideration[n];
            if (
                item.itemType != ItemType.NATIVE || item.token != address(0) || item.identifierOrCriteria != 0
                    || item.startAmount == 0 || item.startAmount != item.endAmount
                    || item.recipient != (n == 0 ? seller : feeRecipient) || item.recipient == address(0)
            ) revert InvalidListing();
            total += item.startAmount;
            if (n == 1) listing.fee = item.startAmount;
        }
        if (total != i.maxNative || listing.fee > p.consideration[0].startAmount / 20) revert InvalidListing();
        OrderComponents memory components = OrderComponents(
            p.offerer,
            p.zone,
            p.offer,
            p.consideration,
            p.orderType,
            p.startTime,
            p.endTime,
            p.zoneHash,
            p.salt,
            p.conduitKey,
            counter
        );
        listing.orderHash = SeaportInterface(SEAPORT).getOrderHash(components);
        (, bool cancelled, uint256 filled,) = SeaportInterface(SEAPORT).getOrderStatus(listing.orderHash);
        if (cancelled || filled != 0) revert InvalidListing();
        listing.tokenId = p.offer[0].identifierOrCriteria;
        if (
            i.paramsHash
                != keccak256(
                    abi.encode(
                        listing.orderHash,
                        address(nft),
                        listing.tokenId,
                        seller,
                        keccak256("1.6"),
                        counter,
                        feeRecipient,
                        listing.fee
                    )
                )
        ) revert InvalidIntent();
        listing.sellerAmount = p.consideration[0].startAmount;
    }
}
