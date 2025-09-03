// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Capped.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract ArcadeTicket is ERC20, ERC20Capped, Ownable {
    uint256 public constant PRICE_WEI = 1;

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 cap_
    ) ERC20(name_, symbol_) ERC20Capped(cap_) Ownable(msg.sender) {}

    function buyToken() external payable {
        require(msg.value == PRICE_WEI, "wrong price");
        _mintWithCap(msg.sender, 1);
    }

    function buyTokens(uint256 amount) external payable {
        require(amount > 0, "amount=0");
        require(msg.value == amount * PRICE_WEI, "wrong price");
        _mintWithCap(msg.sender, amount);
    }

    function airdrop(address[] calldata recipients, uint256[] calldata amounts) external onlyOwner {
        require(recipients.length == amounts.length, "len mismatch");
        for (uint256 i = 0; i < recipients.length; i++) {
            _mintWithCap(recipients[i], amounts[i]);
        }
    }

    function withdraw(address payable to) external onlyOwner {
        require(to != address(0), "zero addr");
        to.transfer(address(this).balance);
    }

    receive() external payable {
        revert("use buyToken(s)");
    }

    function decimals() public pure override returns (uint8) {
        return 0;
    }

    function _mintWithCap(address to, uint256 amount) internal {
        require(totalSupply() + amount <= cap(), "cap exceeded");
        _mint(to, amount);
    }
    
    function _update(address from, address to, uint256 value)
        internal
        override(ERC20, ERC20Capped)
    {
        super._update(from, to, value);
    }
}
