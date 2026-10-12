// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @notice Trusted testnet payment-attestation mint. Does NOT verify Zcash consensus.
contract ZecOneNFT is ERC721, EIP712 {
    struct Intent { address recipient; uint256 zatoshis; bytes32 nonce; uint64 expiry; }
    bytes32 public constant INTENT_TYPEHASH = keccak256("MintIntent(address recipient,uint256 zatoshis,bytes32 nonce,uint64 expiry)");
    uint256 public constant PRICE = 1_000_000; // 0.01 test ZEC; demonstration price only.
    address public immutable relayer;
    mapping(bytes32 => bool) public consumed;
    event OrderMinted(bytes32 indexed orderId, address indexed recipient, uint256 tokenId);
    error TestnetOnly(); error Unauthorized(); error InvalidIntent(); error Replay();

    constructor(address relayer_) ERC721("ZecOne Phase 0", "ZEC0") EIP712("ZecOnePhase0", "1") {
        if (block.chainid != 84532) revert TestnetOnly();
        if (relayer_ == address(0)) revert InvalidIntent();
        relayer = relayer_;
    }
    function orderId(Intent calldata intent) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(INTENT_TYPEHASH, intent.recipient, intent.zatoshis, intent.nonce, intent.expiry)));
    }
    function mint(Intent calldata intent, bytes calldata signature) external {
        if (block.chainid != 84532) revert TestnetOnly();
        if (msg.sender != relayer) revert Unauthorized();
        if (intent.recipient == address(0) || intent.recipient == relayer || intent.zatoshis != PRICE || block.timestamp > intent.expiry) revert InvalidIntent();
        bytes32 id = orderId(intent);
        if (consumed[id]) revert Replay();
        if (ECDSA.recover(id, signature) != intent.recipient) revert InvalidIntent();
        consumed[id] = true;
        // Token ID is predetermined by the signed intent; no arbitrary token URI/call input.
        _safeMint(intent.recipient, uint256(id));
        emit OrderMinted(id, intent.recipient, uint256(id));
    }
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return 'data:application/json;utf8,{"name":"ZecOne Phase 0","description":"Testnet payment-to-mint proof; no monetary value"}';
    }
}
