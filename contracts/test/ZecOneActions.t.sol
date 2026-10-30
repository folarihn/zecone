// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {ZecOneActions} from "../ZecOneActions.sol";

interface VmActions {
    function chainId(uint256) external;
    function warp(uint256) external;
    function prank(address) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function expectRevert(bytes4) external;
}

contract ZecOneActionsTest {
    VmActions constant vm = VmActions(address(uint160(uint256(keccak256("hevm cheat code")))));
    ZecOneActions target;
    uint256 key;
    address user;
    address relayer;

    function setUp() public {
        vm.chainId(84532);
        vm.warp(1000);
        key = uint256(keccak256(abi.encode(address(this), block.timestamp)));
        user = vm.addr(key);
        relayer = address(this);
        target = new ZecOneActions(relayer);
    }

    function intent(bytes32 id) internal view returns (ZecOneActions.Intent memory i) {
        i = ZecOneActions.Intent(
            id,
            84532,
            user,
            address(target),
            abi.encodeCall(target.recordFor, (user, target.NOTE())),
            0,
            target.GAS_BUDGET(),
            target.PRICE(),
            2000
        );
    }

    function signature(ZecOneActions.Intent memory i) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, target.orderId(i));
        return abi.encodePacked(r, s, v);
    }

    function testUserAuthorizedFixedActionAndReplayIsRejected() public {
        ZecOneActions.Intent memory i = intent(bytes32(uint256(1)));
        bytes memory sig = signature(i);
        bytes32 id = target.orderId(i);
        target.execute(i, sig);
        require(target.records(user) == 1);
        require(target.consumed(id));
        vm.expectRevert(ZecOneActions.Replay.selector);
        target.execute(i, sig);
    }

    function testWrongRecipientSignatureFails() public {
        ZecOneActions.Intent memory i = intent(bytes32(uint256(2)));
        bytes memory sig = signature(i);
        i.recipient = address(0x1234);
        i.data = abi.encodeCall(target.recordFor, (i.recipient, target.NOTE()));
        vm.expectRevert(ZecOneActions.InvalidIntent.selector);
        target.execute(i, sig);
    }

    function testArbitraryTargetOrCalldataFails() public {
        ZecOneActions.Intent memory i = intent(bytes32(uint256(3)));
        bytes memory sig = signature(i);
        i.data = abi.encodeCall(target.record, (bytes32(0)));
        vm.expectRevert(ZecOneActions.InvalidIntent.selector);
        target.execute(i, sig);
    }

    function testValueAndBudgetAreFixed() public {
        ZecOneActions.Intent memory i = intent(bytes32(uint256(4)));
        i.maxValue = 1;
        bytes memory sig = signature(i);
        vm.expectRevert(ZecOneActions.InvalidIntent.selector);
        target.execute(i, sig);
    }

    function testExpiredIntentFails() public {
        ZecOneActions.Intent memory i = intent(bytes32(uint256(5)));
        bytes memory sig = signature(i);
        vm.warp(2001);
        vm.expectRevert(ZecOneActions.InvalidIntent.selector);
        target.execute(i, sig);
    }

    function testOnlyRelayerCanExecute() public {
        ZecOneActions.Intent memory i = intent(bytes32(uint256(6)));
        bytes memory sig = signature(i);
        vm.prank(user);
        vm.expectRevert(ZecOneActions.Unauthorized.selector);
        target.execute(i, sig);
    }

    function testMainnetDeploymentAndExecutionFail() public {
        vm.chainId(8453);
        vm.expectRevert(ZecOneActions.TestnetOnly.selector);
        new ZecOneActions(relayer);
    }
}
