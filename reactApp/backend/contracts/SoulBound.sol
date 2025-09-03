// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v4.9.5/contracts/token/ERC721/ERC721.sol";
import "https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v4.9.5/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v4.9.5/contracts/utils/Counters.sol";

contract Soulbound is ERC721, ERC721URIStorage {
    using Counters for Counters.Counter;

    Counters.Counter private _tokenIdCounter;
    mapping(address => uint256) private _userTokens;

    event Attest(address indexed to, uint256 indexed tokenId);
    event Revoke(address indexed account, uint256 indexed tokenId);

    constructor() ERC721("Soulbound", "SLB") {
        _tokenIdCounter.increment(); // parte da 1
    }

    // safeMint(address_to, ipfs://<metadataCID>)
    function safeMint(address to, string memory uri) public {
        require(msg.sender == to, "You can only mint a token for yourself");

        uint256 existingTokenId = _userTokens[to];
        if (existingTokenId != 0) {
            _burn(existingTokenId);
        }

        uint256 newTokenId = _tokenIdCounter.current();
        _tokenIdCounter.increment();

        _safeMint(to, newTokenId);
        _setTokenURI(newTokenId, uri);

        _userTokens[to] = newTokenId;
    }

    function burn(uint256 tokenId) external {
        require(ownerOf(tokenId) == msg.sender, "Only the owner can burn their token");
        _burn(tokenId);
    }

    function getUserToken(address user) external view returns (uint256) {
        return _userTokens[user];
    }

    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 tokenId,
        uint256 batchSize
    ) internal override {
        require(from == address(0) || to == address(0), "Token transfers are not allowed");
        super._beforeTokenTransfer(from, to, tokenId, batchSize);
    }

    function _afterTokenTransfer(
        address from,
        address to,
        uint256 tokenId,
        uint256 batchSize
    ) internal override {
        super._afterTokenTransfer(from, to, tokenId, batchSize);
        if (from == address(0)) {
            emit Attest(to, tokenId);
        } else if (to == address(0)) {
            emit Revoke(from, tokenId);
        }
    }

    function _burn(uint256 tokenId) internal override(ERC721, ERC721URIStorage) {
        address owner = ownerOf(tokenId);
        super._burn(tokenId);
        _userTokens[owner] = 0;
    }

    function tokenURI(
        uint256 tokenId
    ) public view override(ERC721, ERC721URIStorage) returns (string memory) {
        return super.tokenURI(tokenId);
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view override(ERC721, ERC721URIStorage) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
