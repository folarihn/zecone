// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// Fixed demo inventory minted to a separate seller at deployment; ordinary ERC-721 thereafter.
contract MarketTestNFT is ERC721 {
    constructor(address seller) ERC721("Sepolia Studio", "STUDIO") {
        require(block.chainid == 84532 && seller != address(0), "Testnet seller required");
        _mint(seller, 1);
        _mint(seller, 2);
        _mint(seller, 3);
    }
}
