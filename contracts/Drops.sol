// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// SoverStore Private Drops — Polkadot Products Devnet (Asset Hub, pallet-revive).
///
/// Design notes:
/// - Access control is entirely cryptographic. Everything in this contract is public.
///   `envelopeOf` is readable by anyone; only the matching private key makes it useful.
/// - There is no reveal timestamp. Content becomes available to buyers the moment
///   `publish` lands, which is whenever the owner gets around to it after the sale
///   closes. The UI says exactly that; the contract has nothing to enforce.
/// - Drops are independent. Several may be open, closed or published at the same time.
/// @custom:cdm @soverstore/drops
contract Drops {
    address public owner;
    uint256 public dropCount; // ids are 1-based; 0 means "none"

    struct Drop {
        string  name;        // announced file name, public from creation
        uint256 price;       // in the unit established by the phase-0 probe
        uint64  payDeadline; // unix seconds; buying reverts at or after this
        string  cid;         // Bulletin CID of the encrypted blob, set by publish
        bool    published;
        address[] buyers;
    }

    mapping(uint256 => Drop) private drops;

    /// drop => buyer => uncompressed P-256 public key (65 bytes). Empty means not a buyer.
    mapping(uint256 => mapping(address => bytes)) public encKeyOf;

    /// drop => buyer => wrapped content key (125 bytes). Empty means no envelope yet.
    mapping(uint256 => mapping(address => bytes)) public envelopeOf;

    event DropCreated(uint256 indexed id, string name, uint256 price, uint64 payDeadline);
    event Bought(uint256 indexed id, address indexed buyer, bytes encPubKey, uint256 value);
    event EnvelopesAdded(uint256 indexed id, uint256 count);
    event DropPublished(uint256 indexed id, string cid);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor() {
        // Phase 0 established that this app-scoped Product account is the
        // signer available to SoverStore inside the Polkadot host. CDM deploys
        // from a separate tooling account and cannot pass constructor args.
        owner = 0xaEDC9d742B5b124583DC5BfAa07c6D69dc2B5938;
    }

    // --- owner: create ---

    function createDrop(
        string calldata name,
        uint256 price,
        uint64 payDeadline
    ) external onlyOwner returns (uint256 id) {
        require(bytes(name).length > 0, "empty name");
        require(payDeadline > block.timestamp, "deadline in past");

        dropCount += 1;
        id = dropCount;

        Drop storage d = drops[id];
        d.name = name;
        d.price = price;
        d.payDeadline = payDeadline;

        emit DropCreated(id, name, price, payDeadline);
    }

    // --- buyer ---

    /// Registers payment and the buyer's encryption public key in one transaction.
    /// The account (sr25519) key signs; this separate P-256 key receives the envelope.
    function buy(uint256 id, bytes calldata encPubKey) external payable {
        Drop storage d = drops[id];
        require(d.payDeadline != 0, "no such drop");
        require(block.timestamp < d.payDeadline, "sale closed");
        require(msg.value >= d.price, "underpaid");
        require(encPubKey.length == 65 && encPubKey[0] == 0x04, "bad key");
        require(encKeyOf[id][msg.sender].length == 0, "already bought");

        encKeyOf[id][msg.sender] = encPubKey;
        d.buyers.push(msg.sender);

        emit Bought(id, msg.sender, encPubKey, msg.value);
    }

    // --- owner: publish, in two steps so a failed batch can be retried cheaply ---

    /// Callable repeatedly after the sale closes and before `publish`.
    /// Re-sending an existing buyer overwrites their envelope, which makes the
    /// whole publish flow safely re-runnable.
    function addEnvelopes(
        uint256 id,
        address[] calldata buyers,
        bytes[] calldata envelopes
    ) external onlyOwner {
        Drop storage d = drops[id];
        require(d.payDeadline != 0, "no such drop");
        require(block.timestamp >= d.payDeadline, "sale still open");
        require(!d.published, "already published");
        require(buyers.length == envelopes.length, "length mismatch");

        for (uint256 i = 0; i < buyers.length; i++) {
            require(encKeyOf[id][buyers[i]].length != 0, "not a buyer");
            require(envelopes[i].length > 0, "empty envelope");
            envelopeOf[id][buyers[i]] = envelopes[i];
        }

        emit EnvelopesAdded(id, buyers.length);
    }

    /// Locks the drop and points it at the encrypted blob on Bulletin.
    function publish(uint256 id, string calldata cid) external onlyOwner {
        Drop storage d = drops[id];
        require(d.payDeadline != 0, "no such drop");
        require(block.timestamp >= d.payDeadline, "sale still open");
        require(!d.published, "already published");
        require(bytes(cid).length > 0, "empty cid");

        d.cid = cid;
        d.published = true;

        emit DropPublished(id, cid);
    }

    // --- views ---

    function dropInfo(uint256 id)
        external view
        returns (
            string memory name,
            uint256 price,
            uint64 payDeadline,
            string memory cid,
            bool published,
            uint256 buyerCount
        )
    {
        Drop storage d = drops[id];
        return (d.name, d.price, d.payDeadline, d.cid, d.published, d.buyers.length);
    }

    function buyersOf(uint256 id) external view returns (address[] memory) {
        return drops[id].buyers;
    }

    function isBuyer(uint256 id, address who) external view returns (bool) {
        return encKeyOf[id][who].length > 0;
    }

    /// Convenience for the publish flow: buyers and their registered public keys.
    function buyerKeys(uint256 id)
        external view
        returns (address[] memory addrs, bytes[] memory keys)
    {
        addrs = drops[id].buyers;
        keys = new bytes[](addrs.length);
        for (uint256 i = 0; i < addrs.length; i++) {
            keys[i] = encKeyOf[id][addrs[i]];
        }
    }

    // --- owner: funds ---

    function withdraw(address payable to) external onlyOwner {
        (bool ok, ) = to.call{value: address(this).balance}("");
        require(ok, "withdraw failed");
    }
}
