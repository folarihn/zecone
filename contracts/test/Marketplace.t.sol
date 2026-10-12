// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {TestMarketplace} from "../TestMarketplace.sol";
import {MarketTestNFT} from "../MarketTestNFT.sol";
import {ZecOnePurchaseExecutor as Executor} from "../ZecOnePurchaseExecutor.sol";

interface VmMarket {
    function chainId(uint256) external;
    function warp(uint256) external;
    function deal(address, uint256) external;
    function prank(address) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function expectRevert() external;
    function expectRevert(bytes4) external;
}

contract ReentrantBuyer {
    TestMarketplace market;
    bool public blocked;

    constructor(TestMarketplace m) {
        market = m;
    }

    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
        (bool ok,) = address(market).call{value: 0.0001 ether}(abi.encodeCall(market.buy, (2, address(this))));
        blocked = !ok;
        return this.onERC721Received.selector;
    }
}

contract MarketplaceTest {
    VmMarket constant vm = VmMarket(address(uint160(uint256(keccak256("hevm cheat code")))));
    TestMarketplace market;
    MarketTestNFT nft;
    Executor executor;
    uint256 key;
    address user;
    receive() external payable {}

    function setUp() public {
        vm.chainId(84532);
        vm.warp(1000);
        vm.deal(address(this), 10 ether);
        key = uint256(keccak256("synthetic-marketplace-test-only"));
        user = vm.addr(key);
        vm.deal(user, 1 ether);
        market = new TestMarketplace();
        nft = new MarketTestNFT(address(this));
        executor = new Executor(address(this), market);
        nft.setApprovalForAll(address(market), true);
        market.list(address(nft), 1, 0.0001 ether, 10000);
        market.list(address(nft), 2, 0.0001 ether, 10000);
    }

    function quote() internal view returns (Executor.Quote memory q) {
        q = Executor.Quote(
            bytes32(uint256(1)),
            84532,
            address(market),
            1,
            address(nft),
            1,
            address(this),
            user,
            0.0001 ether,
            0.0001 ether,
            1000000,
            0.02 ether,
            0,
            5000,
            keccak256(abi.encodeCall(market.buy, (1, user))),
            keccak256("private refund"),
            keccak256("https://example.test")
        );
    }

    function sig(Executor.Quote memory q) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, executor.quoteId(q));
        return abi.encodePacked(r, s, v);
    }

    function testStandardWalletPurchasePaysSellerAndDeliversDirectly() public {
        uint256 beforeBalance = address(this).balance;
        vm.prank(user);
        market.buy{value: 0.0001 ether}(1, user);
        require(nft.ownerOf(1) == user);
        require(address(this).balance == beforeBalance + 0.0001 ether);
        require(!market.getListing(1).active);
    }

    function testSponsoredPurchaseAndReplay() public {
        Executor.Quote memory q = quote();
        bytes memory s = sig(q);
        executor.execute{value: q.price}(q, s);
        require(nft.ownerOf(1) == user);
        require(executor.consumed(executor.quoteId(q)));
        vm.expectRevert(Executor.Replay.selector);
        executor.execute{value: q.price}(q, s);
    }

    function testWrongListingRejected() public {
        Executor.Quote memory q = quote();
        q.listingId = 99;
        q.calldataHash = keccak256(abi.encodeCall(market.buy, (99, user)));
        bytes memory s = sig(q);
        vm.expectRevert(Executor.ListingChanged.selector);
        executor.execute{value: q.price}(q, s);
    }

    function testChangedRecipientRejected() public {
        Executor.Quote memory q = quote();
        bytes memory s = sig(q);
        q.recipient = address(42);
        q.calldataHash = keccak256(abi.encodeCall(market.buy, (1, q.recipient)));
        vm.expectRevert(Executor.InvalidQuote.selector);
        executor.execute{value: q.price}(q, s);
    }

    function testChangedCalldataRejected() public {
        Executor.Quote memory q = quote();
        q.calldataHash = bytes32(0);
        bytes memory s = sig(q);
        vm.expectRevert(Executor.InvalidQuote.selector);
        executor.execute{value: q.price}(q, s);
    }

    function testChangedPriceRejected() public {
        Executor.Quote memory q = quote();
        q.price = 0.0002 ether;
        q.zatoshis = 1500000;
        bytes memory s = sig(q);
        vm.expectRevert(Executor.ListingChanged.selector);
        executor.execute{value: q.price}(q, s);
    }

    function testWrongNFTRejected() public {
        Executor.Quote memory q = quote();
        q.tokenId = 2;
        bytes memory s = sig(q);
        vm.expectRevert(Executor.ListingChanged.selector);
        executor.execute{value: q.price}(q, s);
    }

    function testExpiredQuoteRejected() public {
        Executor.Quote memory q = quote();
        bytes memory s = sig(q);
        vm.warp(q.expiry);
        vm.expectRevert(Executor.InvalidQuote.selector);
        executor.execute{value: q.price}(q, s);
    }

    function testCancelledListingRejected() public {
        Executor.Quote memory q = quote();
        bytes memory s = sig(q);
        market.cancel(1);
        vm.expectRevert(Executor.ListingChanged.selector);
        executor.execute{value: q.price}(q, s);
    }

    function testSoldListingRejected() public {
        Executor.Quote memory q = quote();
        bytes memory s = sig(q);
        market.buy{value: q.price}(1, user);
        vm.expectRevert(Executor.ListingChanged.selector);
        executor.execute{value: q.price}(q, s);
    }

    function testExpiredListingRejected() public {
        vm.warp(10001);
        vm.expectRevert(TestMarketplace.InvalidPurchase.selector);
        market.buy{value: 0.0001 ether}(1, user);
    }

    function testApprovalRevokedRejected() public {
        nft.setApprovalForAll(address(market), false);
        vm.expectRevert(TestMarketplace.InvalidPurchase.selector);
        market.buy{value: 0.0001 ether}(1, user);
    }

    function testExactPaymentRequired() public {
        vm.expectRevert(TestMarketplace.InvalidPurchase.selector);
        market.buy{value: 0.0002 ether}(1, user);
    }

    function testUnauthorizedSellerRejected() public {
        vm.prank(user);
        vm.expectRevert(TestMarketplace.InvalidListing.selector);
        market.list(address(nft), 1, 1, 9000);
    }

    function testUnauthorizedRelayerRejected() public {
        Executor.Quote memory q = quote();
        bytes memory s = sig(q);
        vm.prank(user);
        vm.expectRevert(Executor.Unauthorized.selector);
        executor.execute{value: q.price}(q, s);
    }

    function testUnauthorizedSignerRejected() public {
        Executor.Quote memory q = quote();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key + 1, executor.quoteId(q));
        vm.expectRevert(Executor.InvalidQuote.selector);
        executor.execute{value: q.price}(q, abi.encodePacked(r, s, v));
    }

    function testCrossContractReplayRejected() public {
        Executor.Quote memory q = quote();
        bytes memory s = sig(q);
        Executor other = new Executor(address(this), market);
        vm.expectRevert(Executor.InvalidQuote.selector);
        other.execute{value: q.price}(q, s);
    }

    function testChainReplayRejected() public {
        Executor.Quote memory q = quote();
        bytes memory s = sig(q);
        vm.chainId(8453);
        vm.expectRevert(Executor.TestnetOnly.selector);
        executor.execute{value: q.price}(q, s);
        vm.expectRevert(TestMarketplace.TestnetOnly.selector);
        new TestMarketplace();
    }

    function testReentrancyBlocked() public {
        ReentrantBuyer attacker = new ReentrantBuyer(market);
        vm.deal(address(attacker), 1 ether);
        market.buy{value: 0.0001 ether}(1, address(attacker));
        require(attacker.blocked());
        require(market.getListing(2).active);
    }

    function testDoublePurchaseRejected() public {
        market.buy{value: 0.0001 ether}(1, user);
        vm.expectRevert(TestMarketplace.InvalidPurchase.selector);
        market.buy{value: 0.0001 ether}(1, user);
    }
}
