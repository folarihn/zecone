// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// Ordinary recipient-directed fixed-price marketplace. No ZecOne permissions.
contract TestMarketplace is ReentrancyGuard {
    struct Listing {
        address nft;
        uint256 tokenId;
        address seller;
        uint256 price;
        uint64 expiry;
        bool active;
    }
    mapping(uint256 => Listing) private listings;
    uint256 public nextId = 1;
    mapping(uint256 => bool) public sold;
    error TestnetOnly();
    error InvalidListing();
    error NotSeller();
    error InvalidPurchase();
    error PaymentFailed();
    event Listed(
        uint256 indexed id, address indexed nft, uint256 indexed tokenId, address seller, uint256 price, uint64 expiry
    );
    event Cancelled(uint256 indexed id);
    event Purchased(
        uint256 indexed id,
        address indexed payer,
        address indexed recipient,
        address nft,
        uint256 tokenId,
        address seller,
        uint256 price
    );

    constructor() {
        if (block.chainid != 84532) revert TestnetOnly();
    }
    modifier testnet() {
        if (block.chainid != 84532) revert TestnetOnly();
        _;
    }

    function getListing(uint256 id) public view returns (Listing memory) {
        return listings[id];
    }

    function valid(uint256 id) public view returns (bool) {
        Listing memory l = listings[id];
        if (!l.active || l.expiry <= block.timestamp) return false;
        return IERC721(l.nft).ownerOf(l.tokenId) == l.seller
            && (IERC721(l.nft).getApproved(l.tokenId) == address(this)
                || IERC721(l.nft).isApprovedForAll(l.seller, address(this)));
    }

    function list(address nft, uint256 tokenId, uint256 price, uint64 expiry)
        external
        testnet
        nonReentrant
        returns (uint256 id)
    {
        if (
            nft.code.length == 0 || !IERC165(nft).supportsInterface(type(IERC721).interfaceId) || price == 0
                || expiry <= block.timestamp
        ) revert InvalidListing();
        if (
            IERC721(nft).ownerOf(tokenId) != msg.sender
                || !(IERC721(nft).getApproved(tokenId) == address(this)
                    || IERC721(nft).isApprovedForAll(msg.sender, address(this)))
        ) revert InvalidListing();
        id = nextId++;
        listings[id] = Listing(nft, tokenId, msg.sender, price, expiry, true);
        emit Listed(id, nft, tokenId, msg.sender, price, expiry);
    }

    function cancel(uint256 id) external testnet nonReentrant {
        if (listings[id].seller != msg.sender) revert NotSeller();
        if (!listings[id].active) revert InvalidListing();
        listings[id].active = false;
        emit Cancelled(id);
    }

    function buy(uint256 id, address recipient) external payable testnet nonReentrant {
        Listing memory l = listings[id];
        if (recipient == address(0) || recipient == l.seller || msg.value != l.price || !valid(id)) revert InvalidPurchase();
        listings[id].active = false;
        sold[id] = true;
        IERC721(l.nft).safeTransferFrom(l.seller, recipient, l.tokenId);
        (bool paid,) = payable(l.seller).call{value: l.price}("");
        if (!paid) revert PaymentFailed();
        emit Purchased(id, msg.sender, recipient, l.nft, l.tokenId, l.seller, l.price);
    }
}
