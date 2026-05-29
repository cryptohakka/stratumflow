// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract RebalanceRecorder {
    address public agent;

    event RebalanceExecuted(
        string regime,
        string fromAsset,
        string toAsset,
        uint256 amount,
        uint256 rwaScore,
        uint256 timestamp
    );

    event RegimeChanged(
        string oldRegime,
        string newRegime,
        uint256 confidence,
        uint256 timestamp
    );

    modifier onlyAgent() {
        require(msg.sender == agent, "not agent");
        _;
    }

    constructor() {
        agent = msg.sender;
    }

    function recordRebalance(
        string calldata regime,
        string calldata fromAsset,
        string calldata toAsset,
        uint256 amount,
        uint256 rwaScore
    ) external onlyAgent {
        emit RebalanceExecuted(regime, fromAsset, toAsset, amount, rwaScore, block.timestamp);
    }

    function recordRegimeChange(
        string calldata oldRegime,
        string calldata newRegime,
        uint256 confidence
    ) external onlyAgent {
        emit RegimeChanged(oldRegime, newRegime, confidence, block.timestamp);
    }
}
