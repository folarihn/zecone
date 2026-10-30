// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestMarketplace} from "../TestMarketplace.sol";
import {MarketTestNFT} from "../MarketTestNFT.sol";
import {ZecOneMultichainExecutor} from "../ZecOneMultichainExecutor.sol";

interface VmMultichain {
    function chainId(uint256) external;
    function warp(uint256) external;
    function deal(address, uint256) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function txGasPrice(uint256) external;
    function expectRevert(bytes4) external;
}

contract MultichainExecutorTest {
    VmMultichain constant vm = VmMultichain(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 constant USER_KEY = 0xA11CE;
    TestMarketplace market;
    MarketTestNFT nft;
    ZecOneMultichainExecutor executor;
    address user;

    receive() external payable {}

    function setUp() public {
        vm.chainId(11155111);
        vm.warp(1000);
        vm.txGasPrice(1 gwei);
        user = vm.addr(USER_KEY);
        vm.deal(user, 1 ether);
        market = new TestMarketplace();
        nft = new MarketTestNFT(address(this));
        nft.setApprovalForAll(address(market), true);
        market.list(address(nft), 1, 0.0001 ether, 4000);
        executor = new ZecOneMultichainExecutor(address(this), market);
        vm.deal(address(this), 1 ether);
    }

    function makeQuote(bytes32 orderId) internal view returns (ZecOneMultichainExecutor.Quote memory q) {
        q = ZecOneMultichainExecutor.Quote({
            sourceNetwork: keccak256("zcash-testnet"),
            provider: address(this),
            adapter: keccak256(bytes("ethereum-sepolia-v2")),
            orderId: orderId,
            chainId: 11155111,
            marketplace: address(market),
            listingId: 1,
            nft: address(nft),
            tokenId: 1,
            seller: address(this),
            recipient: user,
            price: 0.0001 ether,
            gasBudget: 0.0005 ether,
            zatoshis: 3000000,
            rate: 0.02 ether,
            maxSlippageBps: 0,
            expiry: 3000,
            calldataHash: keccak256(abi.encodeCall(market.buy, (1, user))),
            refundHash: keccak256("refund destination"),
            originHash: keccak256("approved origin")
        });
    }

    function testSponsoredPurchaseBindsChainAndRecipientAndRejectsReplay() public {
        ZecOneMultichainExecutor.Quote memory q = makeQuote(keccak256("phase4a-order"));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(USER_KEY, executor.quoteId(q));
        bytes memory signature = abi.encodePacked(r, s, v);
        executor.execute{value: q.price}(q, signature);
        require(nft.ownerOf(1) == user, "recipient did not receive NFT");
        require(address(this).balance == 1 ether, "seller did not receive exact price");
        vm.expectRevert(ZecOneMultichainExecutor.Replay.selector);
        executor.execute{value: q.price}(q, signature);
    }

    function testWrongChainAndWrongAdapterFailClosed() public {
        ZecOneMultichainExecutor.Quote memory q = makeQuote(keccak256("wrong-chain"));
        q.adapter = keccak256(bytes("robinhood-testnet-v2"));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(USER_KEY, executor.quoteId(q));
        vm.expectRevert(ZecOneMultichainExecutor.InvalidQuote.selector);
        executor.execute{value: q.price}(q, abi.encodePacked(r, s, v));

        vm.chainId(46630);
        vm.expectRevert(ZecOneMultichainExecutor.TestnetOnly.selector);
        executor.execute{value: q.price}(q, abi.encodePacked(r, s, v));
    }

    function testWrongRecipientAndChangedListingCannotSettle() public {
        ZecOneMultichainExecutor.Quote memory q = makeQuote(keccak256("recipient-mismatch"));
        q.recipient = address(0xBEEF);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(USER_KEY, executor.quoteId(q));
        vm.expectRevert(ZecOneMultichainExecutor.InvalidQuote.selector);
        executor.execute{value: q.price}(q, abi.encodePacked(r, s, v));

        q = makeQuote(keccak256("changed-listing"));
        q.listingId = 2;
        (v, r, s) = vm.sign(USER_KEY, executor.quoteId(q));
        vm.expectRevert(ZecOneMultichainExecutor.InvalidQuote.selector);
        executor.execute{value: q.price}(q, abi.encodePacked(r, s, v));
    }

    function testExpiredAndCancelledListingsCannotSettle() public {
        ZecOneMultichainExecutor.Quote memory q = makeQuote(keccak256("expired-quote"));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(USER_KEY, executor.quoteId(q));
        vm.warp(3001);
        vm.expectRevert(ZecOneMultichainExecutor.InvalidQuote.selector);
        executor.execute{value: q.price}(q, abi.encodePacked(r, s, v));

        vm.warp(1000);
        market.cancel(1);
        q = makeQuote(keccak256("cancelled-listing"));
        (v, r, s) = vm.sign(USER_KEY, executor.quoteId(q));
        vm.expectRevert(ZecOneMultichainExecutor.ListingChanged.selector);
        executor.execute{value: q.price}(q, abi.encodePacked(r, s, v));
    }

    function testRobinhoodTestnetUsesItsOwnImmutableExecutionPolicy() public {
        vm.chainId(46630);
        TestMarketplace rhMarket = new TestMarketplace();
        MarketTestNFT rhNft = new MarketTestNFT(address(this));
        ZecOneMultichainExecutor rhExecutor = new ZecOneMultichainExecutor(address(this), rhMarket);
        require(rhExecutor.CHAIN() == 46630, "wrong chain binding");
        require(rhExecutor.GAS_BUDGET() == 0.0002 ether, "wrong gas reserve");
        require(rhExecutor.MAX_FEE() == 1 gwei, "wrong fee cap");
        require(rhExecutor.ADAPTER() == keccak256(bytes("robinhood-testnet-v2")), "wrong adapter");
        require(rhNft.ownerOf(1) == address(this), "seller inventory missing");
    }

    function testMainnetDeploymentIsRejected() public {
        vm.chainId(1);
        vm.expectRevert(ZecOneMultichainExecutor.TestnetOnly.selector);
        new ZecOneMultichainExecutor(address(this), market);
    }
}
