// SPDX-License-Identifier: MIT
pragma solidity ^0.8.4;

contract DataMaskRegistry {
    struct MaskData {
        string photo;
        string mask;
    }

    mapping(address => MaskData) public maskData;

    event MaskDataUpdated(address account, string oldPhoto, string oldMask, string newPhoto, string newMask);

    function setMaskData(string memory newPhoto, string memory newMask) public {
        address account = msg.sender;

        // Memorizziamo gli hash vecchi per l'evento
        string memory oldPhoto = maskData[account].photo;
        string memory oldMask = maskData[account].mask;

        // Aggiorniamo i nuovi hash
        maskData[account].photo = newPhoto;
        maskData[account].mask = newMask;

        emit MaskDataUpdated(account, oldPhoto, oldMask, newPhoto, newMask);
    }

    function getMaskData(address account) public view returns (string memory, string memory) {
        return (maskData[account].photo, maskData[account].mask);
    }
}