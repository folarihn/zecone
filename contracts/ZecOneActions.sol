// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// Testnet sponsorship only. No arbitrary target, value transfer or delegated user signing.
contract ZecOneActions is EIP712 {
    struct Intent { bytes32 orderId; uint256 chainId; address recipient; address target; bytes data; uint256 maxValue; uint256 maxGasBudget; uint256 zatoshis; uint64 expiry; }
    bytes32 constant TYPEHASH=keccak256("ActionIntent(bytes32 orderId,uint256 chainId,address recipient,address target,bytes data,uint256 maxValue,uint256 maxGasBudget,uint256 zatoshis,uint64 expiry)");
    bytes32 public constant NOTE=keccak256("ZecOne Phase 2 shielded sponsorship");
    uint256 public constant PRICE=1_000_000;
    uint256 public constant GAS_BUDGET=0.005 ether;
    address public immutable relayer;
    mapping(bytes32=>bool) public consumed;
    mapping(bytes32=>bool) public usedOrderIds;
    mapping(address=>uint256) public records;
    error TestnetOnly(); error Unauthorized(); error InvalidIntent(); error Replay();
    event Recorded(address indexed account,bytes32 note,uint256 count);
    event ActionExecuted(bytes32 indexed digest,bytes32 indexed orderId,address indexed recipient);
    constructor(address payer) EIP712("ZecOnePhase2","1"){if(block.chainid!=84532)revert TestnetOnly();if(payer==address(0))revert InvalidIntent();relayer=payer;}
    function orderId(Intent calldata i) public view returns(bytes32){return _hashTypedDataV4(keccak256(abi.encode(TYPEHASH,i.orderId,i.chainId,i.recipient,i.target,keccak256(i.data),i.maxValue,i.maxGasBudget,i.zatoshis,i.expiry)));}
    function record(bytes32 note) external {if(block.chainid!=84532)revert TestnetOnly();emit Recorded(msg.sender,note,++records[msg.sender]);}
    function recordFor(address account,bytes32 note) external {if(msg.sender!=address(this))revert Unauthorized();emit Recorded(account,note,++records[account]);}
    function execute(Intent calldata i,bytes calldata signature) external {
        if(block.chainid!=84532)revert TestnetOnly();if(msg.sender!=relayer)revert Unauthorized();
        if(i.chainId!=84532||i.target!=address(this)||i.recipient==address(0)||i.recipient==relayer||i.orderId==bytes32(0)||i.maxValue!=0||i.maxGasBudget!=GAS_BUDGET||i.zatoshis!=PRICE||i.expiry<=block.timestamp||keccak256(i.data)!=keccak256(abi.encodeCall(this.recordFor,(i.recipient,NOTE))))revert InvalidIntent();
        bytes32 id=orderId(i);if(consumed[id]||usedOrderIds[i.orderId])revert Replay();
        if(ECDSA.recover(id,signature)!=i.recipient)revert InvalidIntent();
        consumed[id]=true;usedOrderIds[i.orderId]=true;
        this.recordFor(i.recipient,NOTE);
        emit ActionExecuted(id,i.orderId,i.recipient);
    }
}
