// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
// Adversarial local mocks; actual Uniswap reserves/swaps are tested separately on Anvil.
import {ZecOneSwapExecutor as Executor, IV2Router} from "../ZecOneSwapExecutor.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface VmSwap {
    function chainId(uint256) external;
    function warp(uint256) external;
    function deal(address, uint256) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function prank(address) external;
}

contract HostileSwapToken is ERC20 {
    uint8 public mode;
    address public callback;
    bytes public payload;
    bool public reentryBlocked;

    constructor() ERC20("Synthetic", "SYN") {
        _mint(msg.sender, 10000 ether);
    }

    function setMode(uint8 m) external {
        mode = m;
    }

    function hook(address a, bytes calldata d) external {
        callback = a;
        payload = d;
    }

    function decimals() public view override returns (uint8) {
        return mode == 3 ? 6 : 18;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(mode != 2, "blacklist/pause");
        if (callback != address(0)) {
            (bool ok,) = callback.call(payload);
            reentryBlocked = !ok;
        }
        if (mode == 1 && from != address(0)) {
            super._update(from, address(0), value / 100);
            super._update(from, to, value - value / 100);
        } else {
            super._update(from, to, value);
        }
    }
}

contract MockSwapRouter {
    HostileSwapToken public token;
    uint256 public amount = 100 ether;
    uint8 public mode;

    constructor(HostileSwapToken t) {
        token = t;
    }

    function setMode(uint8 m) external {
        mode = m;
    }

    function factory() external view returns (address) {
        return address(this);
    }

    function WETH() external pure returns (address) {
        return address(0xBEEF);
    }

    function getPair(address, address) external view returns (address) {
        return address(this);
    }

    function getAmountsOut(uint256 input, address[] calldata) external view returns (uint256[] memory a) {
        a = new uint256[](2);
        a[0] = input;
        a[1] = mode == 1 ? 1 : amount;
    }

    function swapExactETHForTokens(uint256, address[] calldata, address recipient, uint256)
        external
        payable
        returns (uint256[] memory a)
    {
        require(mode != 2, "router failed");
        a = new uint256[](2);
        a[0] = msg.value;
        a[1] = amount;
        token.transfer(mode == 3 ? address(0xBAD) : recipient, amount);
    }
}

contract SwapExecutorTest {
    VmSwap constant vm = VmSwap(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 constant KEY = 0xA11CE;
    Executor e;
    HostileSwapToken t;
    MockSwapRouter r;
    address user;

    function setUp() public {
        vm.chainId(84532);
        vm.warp(1000);
        vm.deal(address(this), 1 ether);
        user = vm.addr(KEY);
        t = new HostileSwapToken();
        r = new MockSwapRouter(t);
        t.transfer(address(r), 1000 ether);
        e = new Executor(address(this), IV2Router(address(r)), t);
    }

    function quote() internal view returns (Executor.Intent memory i, Executor.Swap memory s) {
        address[] memory path = new address[](2);
        path[0] = address(0xBEEF);
        path[1] = address(t);
        s = Executor.Swap(
            address(0xBEEF),
            0.0001 ether,
            address(t),
            18,
            address(r),
            keccak256(abi.encode(path)),
            100 ether,
            99 ether,
            100,
            3000,
            1,
            bytes32(uint256(1))
        );
        i = Executor.Intent(
            keccak256("TOKEN_SWAP"),
            keccak256("zcash-testnet"),
            84532,
            bytes32(uint256(2)),
            bytes32(uint256(3)),
            user,
            address(this),
            keccak256("uniswap-v2-native-v1"),
            address(r),
            0.0001 ether,
            0.0001 ether,
            1000000,
            3000,
            keccak256(abi.encode(s)),
            keccak256(abi.encodeCall(IV2Router.swapExactETHForTokens, (s.minOut, path, user, s.deadline))),
            bytes32(uint256(4))
        );
    }

    function sign(Executor.Intent memory i) internal returns (bytes memory) {
        (uint8 v, bytes32 a, bytes32 b) = vm.sign(KEY, e.intentId(i));
        return abi.encodePacked(a, b, v);
    }

    function testDeliveryReplayAndNoAllowance() public {
        (Executor.Intent memory i, Executor.Swap memory s) = quote();
        bytes memory sig = sign(i);
        e.execute{value: i.maxNative}(i, s, sig);
        require(t.balanceOf(user) == 100 ether);
        require(t.allowance(user, address(e)) == 0);
        vm.expectRevert(Executor.Replay.selector);
        e.execute{value: i.maxNative}(i, s, sig);
    }

    function testFeeOnTransferRollsBackConsumption() public {
        (Executor.Intent memory i, Executor.Swap memory s) = quote();
        bytes memory sig = sign(i);
        t.setMode(1);
        vm.expectRevert(Executor.ReceiptMismatch.selector);
        e.execute{value: i.maxNative}(i, s, sig);
        require(!e.consumed(e.intentId(i)));
        require(t.balanceOf(user) == 0);
    }

    function testPauseBlacklistAndRouterRevert() public {
        (Executor.Intent memory i, Executor.Swap memory s) = quote();
        bytes memory sig = sign(i);
        t.setMode(2);
        vm.expectRevert();
        e.execute{value: i.maxNative}(i, s, sig);
        t.setMode(0);
        r.setMode(2);
        vm.expectRevert();
        e.execute{value: i.maxNative}(i, s, sig);
        require(!e.consumed(e.intentId(i)));
    }

    function testChangedDecimalsFails() public {
        (Executor.Intent memory i, Executor.Swap memory s) = quote();
        bytes memory sig = sign(i);
        t.setMode(3);
        vm.expectRevert(Executor.InvalidIntent.selector);
        e.execute{value: i.maxNative}(i, s, sig);
    }

    function testSlippageAndWrongDelivery() public {
        (Executor.Intent memory i, Executor.Swap memory s) = quote();
        bytes memory sig = sign(i);
        r.setMode(1);
        vm.expectRevert(Executor.Slippage.selector);
        e.execute{value: i.maxNative}(i, s, sig);
        r.setMode(3);
        vm.expectRevert(Executor.ReceiptMismatch.selector);
        e.execute{value: i.maxNative}(i, s, sig);
    }

    function testExactMinimumAndDeadline() public {
        (Executor.Intent memory i, Executor.Swap memory s) = quote();
        s.slippageBps = 1;
        s.minOut = s.expectedOut * 9999 / 10000;
        i.paramsHash = keccak256(abi.encode(s));
        address[] memory p = new address[](2);
        p[0] = s.inputAsset;
        p[1] = s.outputToken;
        i.calldataHash = keccak256(abi.encodeCall(IV2Router.swapExactETHForTokens, (s.minOut, p, user, s.deadline)));
        bytes memory sig = sign(i);
        vm.warp(3000);
        vm.expectRevert(Executor.InvalidIntent.selector);
        e.execute{value: i.maxNative}(i, s, sig);
    }

    function testWrongChainProviderAndRecipient() public {
        (Executor.Intent memory i, Executor.Swap memory s) = quote();
        bytes memory sig = sign(i);
        vm.chainId(1);
        vm.expectRevert(Executor.InvalidIntent.selector);
        e.execute{value: i.maxNative}(i, s, sig);
        vm.chainId(84532);
        vm.prank(user);
        vm.expectRevert();
        e.execute(i, s, sig);
        i.recipient = address(0xBAD);
        vm.expectRevert(Executor.InvalidIntent.selector);
        e.execute{value: i.maxNative}(i, s, sig);
    }

    function testCalldataAndRouteTampering() public {
        (Executor.Intent memory i, Executor.Swap memory s) = quote();
        bytes memory sig = sign(i);
        i.calldataHash = keccak256("altered");
        vm.expectRevert(Executor.InvalidIntent.selector);
        e.execute{value: i.maxNative}(i, s, sig);
        (i, s) = quote();
        s.routeHash = keccak256("altered");
        vm.expectRevert(Executor.InvalidIntent.selector);
        e.execute{value: i.maxNative}(i, s, sig);
    }

    function testTokenCallbackCannotReenter() public {
        (Executor.Intent memory i, Executor.Swap memory s) = quote();
        bytes memory sig = sign(i);
        t.hook(address(e), abi.encodeCall(e.execute, (i, s, sig)));
        e.execute{value: i.maxNative}(i, s, sig);
        require(t.reentryBlocked());
        require(t.balanceOf(user) == 100 ether);
    }

    function testWrongRouterAndFutureActionFailClosed() public {
        (Executor.Intent memory i, Executor.Swap memory s) = quote();
        i.action = keccak256("FUTURE_MARKETPLACE_ORDER");
        bytes memory sig = sign(i);
        vm.expectRevert(Executor.InvalidIntent.selector);
        e.execute{value: i.maxNative}(i, s, sig);
        (i, s) = quote();
        s.router = address(0xBAD);
        sig = sign(i);
        vm.expectRevert(Executor.InvalidIntent.selector);
        e.execute{value: i.maxNative}(i, s, sig);
    }

    function testMainnetConstructorAndMalformedToken() public {
        vm.chainId(1);
        vm.expectRevert();
        new Executor(address(this), IV2Router(address(r)), t);
        vm.chainId(84532);
        t.setMode(3);
        vm.expectRevert();
        new Executor(address(this), IV2Router(address(r)), t);
    }
}
