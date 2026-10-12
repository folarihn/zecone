// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {ZecOneNFT} from "../ZecOneNFT.sol";
interface Vm {
    function chainId(uint256) external;
    function warp(uint256) external;
    function prank(address) external;
    function addr(uint256) external returns (address);
    function sign(uint256,bytes32) external returns (uint8,bytes32,bytes32);
    function expectRevert(bytes4) external;
}
contract ZecOneNFTTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    ZecOneNFT nft;
    uint256 key;
    address user;
    function setUp() public {
        vm.chainId(84532); vm.warp(1000);
        // Local EVM fixture key derived only for this test, never a funded wallet credential.
        key = uint256(keccak256(abi.encode(address(this),block.timestamp)));
        user = vm.addr(key); nft = new ZecOneNFT(address(this));
    }
    function intent(bytes32 nonce) internal view returns (ZecOneNFT.Intent memory) {
        return ZecOneNFT.Intent(user,1_000_000,nonce,2000);
    }
    function sign(ZecOneNFT target,ZecOneNFT.Intent memory i) internal returns(bytes memory) {
        (uint8 v,bytes32 r,bytes32 s)=vm.sign(key,target.orderId(i)); return abi.encodePacked(r,s,v);
    }
    function testFuzz_UserOwnsNFTAndReplayFails(bytes32 nonce) public {
        ZecOneNFT.Intent memory i=intent(nonce);bytes memory sig=sign(nft,i);bytes32 id=nft.orderId(i);
        nft.mint(i,sig);require(nft.ownerOf(uint256(id))==user);require(nft.consumed(id));
        vm.expectRevert(ZecOneNFT.Replay.selector);nft.mint(i,sig);
    }
    function testUnauthorizedRelayer() public {
        ZecOneNFT.Intent memory i=intent(bytes32(uint256(1)));bytes memory sig=sign(nft,i);
        vm.prank(user);vm.expectRevert(ZecOneNFT.Unauthorized.selector);nft.mint(i,sig);
    }
    function testChangedRecipientFails() public {
        ZecOneNFT.Intent memory i=intent(bytes32(uint256(1)));bytes memory sig=sign(nft,i);i.recipient=address(0x1234);
        vm.expectRevert(ZecOneNFT.InvalidIntent.selector);nft.mint(i,sig);
    }
    function testExpiredFails() public {
        ZecOneNFT.Intent memory i=intent(bytes32(uint256(1)));bytes memory sig=sign(nft,i);vm.warp(2001);
        vm.expectRevert(ZecOneNFT.InvalidIntent.selector);nft.mint(i,sig);
    }
    function testWrongPriceFails() public {
        ZecOneNFT.Intent memory i=intent(bytes32(uint256(1)));i.zatoshis=1;bytes memory sig=sign(nft,i);
        vm.expectRevert(ZecOneNFT.InvalidIntent.selector);nft.mint(i,sig);
    }
    function testCrossContractReplayFails() public {
        ZecOneNFT.Intent memory i=intent(bytes32(uint256(1)));bytes memory sig=sign(nft,i);ZecOneNFT other=new ZecOneNFT(address(this));
        vm.expectRevert(ZecOneNFT.InvalidIntent.selector);other.mint(i,sig);
    }
    function testMainnetDeployFails() public {
        vm.chainId(8453);vm.expectRevert(ZecOneNFT.TestnetOnly.selector);new ZecOneNFT(address(this));
    }
    function testMainnetExecutionFails() public {
        ZecOneNFT.Intent memory i=intent(bytes32(uint256(1)));bytes memory sig=sign(nft,i);vm.chainId(8453);
        vm.expectRevert(ZecOneNFT.TestnetOnly.selector);nft.mint(i,sig);
    }
}
