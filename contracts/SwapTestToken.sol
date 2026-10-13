// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// Fixed supply, ordinary transfers, no mint authority, tax, pause, blacklist or callbacks.
contract SwapTestToken is ERC20 {
    constructor(address liquidityOwner) ERC20("ZecOne Test Token", "ZTEST") {
        require(block.chainid == 84532, "Base Sepolia only");
        require(liquidityOwner != address(0), "recipient");
        _mint(liquidityOwner, 10000 ether);
    }
}
