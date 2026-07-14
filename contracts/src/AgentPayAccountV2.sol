// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AgentPayAccountV2
/// @notice Non-upgradeable AgentPay account whose executor can only submit
///         owner-signed EIP-712 direct or allowlisted route authorizations.
/// @dev This contract deliberately has no unsigned execution or arbitrary
///      contract-call entrypoint. The owner signature is the payment proof.
contract AgentPayAccountV2 {
    struct DirectPaymentAuthorization {
        bytes32 intentIdHash;
        bytes32 tenantIdHash;
        bytes32 paymentType;
        address owner;
        address account;
        address token;
        address recipient;
        uint256 amount;
        uint256 nonce;
        uint256 deadline;
        bytes32 purposeHash;
    }

    struct RoutePaymentAuthorization {
        bytes32 intentIdHash;
        bytes32 tenantIdHash;
        bytes32 paymentType;
        address owner;
        address account;
        address sourceToken;
        uint256 maxAmountIn;
        uint256 destinationChainId;
        address destinationToken;
        address recipient;
        uint256 minAmountOut;
        address routeTarget;
        bytes32 routeCalldataHash;
        uint256 maxNativeFee;
        uint256 nonce;
        uint256 deadline;
        bytes32 purposeHash;
    }

    error Paused();
    error CalldataHashMismatch();
    error DeadlineExpired(uint256 deadline);
    error DeadlineTooFar(uint256 deadline, uint256 maximum);
    error ExternalCallFailed(bytes reason);
    error ExecutorCannotBeOwner();
    error InsufficientTokenBalance(address token, uint256 required, uint256 available);
    error InvalidAmount();
    error InvalidDestinationChain();
    error InvalidDestinationToken();
    error InvalidRecipient();
    error InvalidSignature();
    error NativeFeeTooHigh(uint256 sent, uint256 maxAllowed);
    error NonceAlreadyUsed(uint256 nonce);
    error NotExecutor();
    error NotOwner();
    error OwnerMustBeEOA();
    error Reentrancy();
    error RouteTargetNotAllowed(address target);
    error TokenNotAllowed(address token);
    error ZeroAddress();

    event AuthorizedDirectPaymentExecuted(
        bytes32 indexed intentIdHash,
        bytes32 indexed authorizationHash,
        uint256 indexed nonce,
        address token,
        address recipient,
        uint256 amount
    );

    event AuthorizedRoutePaymentExecuted(
        bytes32 indexed intentIdHash,
        bytes32 indexed authorizationHash,
        uint256 indexed nonce,
        address sourceToken,
        address routeTarget,
        uint256 maxAmountIn,
        uint256 minAmountOut
    );

    event NonceCancelled(uint256 indexed nonce);
    event ExecutorUpdated(address indexed oldExecutor, address indexed newExecutor);
    event TokenAllowedUpdated(address indexed token, bool allowed);
    event RouteTargetAllowedUpdated(address indexed target, bool allowed);
    event WithdrawnToken(address indexed token, address indexed to, uint256 amount);
    event WithdrawnNative(address indexed to, uint256 amount);
    event AccountPaused();
    event AccountUnpaused();

    bytes32 public constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant DIRECT_PAYMENT_TYPEHASH = keccak256(
        "DirectPaymentAuthorization(bytes32 intentIdHash,bytes32 tenantIdHash,bytes32 paymentType,address owner,address account,address token,address recipient,uint256 amount,uint256 nonce,uint256 deadline,bytes32 purposeHash)"
    );
    bytes32 public constant ROUTE_PAYMENT_TYPEHASH = keccak256(
        "RoutePaymentAuthorization(bytes32 intentIdHash,bytes32 tenantIdHash,bytes32 paymentType,address owner,address account,address sourceToken,uint256 maxAmountIn,uint256 destinationChainId,address destinationToken,address recipient,uint256 minAmountOut,address routeTarget,bytes32 routeCalldataHash,uint256 maxNativeFee,uint256 nonce,uint256 deadline,bytes32 purposeHash)"
    );

    bytes32 private constant _NAME_HASH = keccak256("AgentPay");
    bytes32 private constant _VERSION_HASH = keccak256("1");
    bytes32 private constant _DIRECT_PAYMENT = keccak256("DIRECT_PAYMENT");
    bytes32 private constant _ROUTE_PAYMENT = keccak256("ROUTE_PAYMENT");

    uint256 private constant _DIRECT_DEADLINE_WINDOW = 15 minutes;
    uint256 private constant _ROUTE_DEADLINE_WINDOW = 5 minutes;
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private constant _SECP256K1_N_HALF = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    address public immutable owner;
    address public executor;
    bool public paused;

    mapping(uint256 => bool) public usedNonces;
    mapping(address => bool) public allowedTokens;
    mapping(address => bool) public allowedRouteTargets;

    uint256 private _reentrancyStatus;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyExecutor() {
        if (msg.sender != executor) revert NotExecutor();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier nonReentrant() {
        if (_reentrancyStatus == _ENTERED) revert Reentrancy();
        _reentrancyStatus = _ENTERED;
        _;
        _reentrancyStatus = _NOT_ENTERED;
    }

    constructor(
        address initialOwner,
        address initialExecutor,
        address[] memory initialAllowedTokens,
        address[] memory initialAllowedRouteTargets
    ) {
        if (initialOwner == address(0) || initialExecutor == address(0)) {
            revert ZeroAddress();
        }
        if (initialOwner.code.length != 0) revert OwnerMustBeEOA();
        if (initialOwner == initialExecutor) revert ExecutorCannotBeOwner();

        owner = initialOwner;
        executor = initialExecutor;
        _reentrancyStatus = _NOT_ENTERED;

        for (uint256 index = 0; index < initialAllowedTokens.length; index++) {
            address token = initialAllowedTokens[index];
            if (token == address(0)) revert ZeroAddress();
            allowedTokens[token] = true;
            emit TokenAllowedUpdated(token, true);
        }

        for (uint256 index = 0; index < initialAllowedRouteTargets.length; index++) {
            address target = initialAllowedRouteTargets[index];
            if (target == address(0)) revert ZeroAddress();
            allowedRouteTargets[target] = true;
            emit RouteTargetAllowedUpdated(target, true);
        }
    }

    receive() external payable {}

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, address(this)));
    }

    function hashDirectAuthorization(DirectPaymentAuthorization calldata authorization)
        external
        view
        returns (bytes32)
    {
        return _hashDirectAuthorization(authorization);
    }

    function hashRouteAuthorization(RoutePaymentAuthorization calldata authorization) external view returns (bytes32) {
        return _hashRouteAuthorization(authorization);
    }

    function setExecutor(address newExecutor) external onlyOwner {
        if (newExecutor == address(0)) revert ZeroAddress();
        if (newExecutor == owner) revert ExecutorCannotBeOwner();

        address oldExecutor = executor;
        executor = newExecutor;
        emit ExecutorUpdated(oldExecutor, newExecutor);
    }

    function setAllowedToken(address token, bool allowed) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        allowedTokens[token] = allowed;
        emit TokenAllowedUpdated(token, allowed);
    }

    function setAllowedRouteTarget(address target, bool allowed) external onlyOwner {
        if (target == address(0)) revert ZeroAddress();
        allowedRouteTargets[target] = allowed;
        emit RouteTargetAllowedUpdated(target, allowed);
    }

    function cancelNonce(uint256 nonce) external onlyOwner {
        if (usedNonces[nonce]) revert NonceAlreadyUsed(nonce);
        usedNonces[nonce] = true;
        emit NonceCancelled(nonce);
    }

    function pause() external onlyOwner {
        paused = true;
        emit AccountPaused();
    }

    function unpause() external onlyOwner {
        paused = false;
        emit AccountUnpaused();
    }

    function withdrawToken(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        if (amount == 0) revert InvalidAmount();
        _safeTransfer(token, to, amount);
        emit WithdrawnToken(token, to, amount);
    }

    function withdrawNative(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert InvalidAmount();

        (bool success, bytes memory reason) = to.call{value: amount}("");
        if (!success) revert ExternalCallFailed(reason);
        emit WithdrawnNative(to, amount);
    }

    function executeAuthorizedDirectPayment(DirectPaymentAuthorization calldata authorization, bytes calldata signature)
        external
        onlyExecutor
        whenNotPaused
        nonReentrant
    {
        bytes32 authorizationHash = _validateDirectAuthorization(authorization, signature);

        usedNonces[authorization.nonce] = true;
        _safeTransfer(authorization.token, authorization.recipient, authorization.amount);

        emit AuthorizedDirectPaymentExecuted(
            authorization.intentIdHash,
            authorizationHash,
            authorization.nonce,
            authorization.token,
            authorization.recipient,
            authorization.amount
        );
    }

    function executeAuthorizedRoutePayment(
        RoutePaymentAuthorization calldata authorization,
        bytes calldata routeCalldata,
        bytes calldata signature
    ) external payable onlyExecutor whenNotPaused nonReentrant {
        bytes32 authorizationHash = _validateRouteAuthorization(authorization, routeCalldata, signature);

        usedNonces[authorization.nonce] = true;
        _safeApprove(authorization.sourceToken, authorization.routeTarget, 0);
        _safeApprove(authorization.sourceToken, authorization.routeTarget, authorization.maxAmountIn);

        (bool success, bytes memory reason) = authorization.routeTarget.call{value: msg.value}(routeCalldata);
        if (!success) revert ExternalCallFailed(reason);

        _safeApprove(authorization.sourceToken, authorization.routeTarget, 0);

        emit AuthorizedRoutePaymentExecuted(
            authorization.intentIdHash,
            authorizationHash,
            authorization.nonce,
            authorization.sourceToken,
            authorization.routeTarget,
            authorization.maxAmountIn,
            authorization.minAmountOut
        );
    }

    function _validateDirectAuthorization(DirectPaymentAuthorization calldata authorization, bytes calldata signature)
        private
        view
        returns (bytes32 authorizationHash)
    {
        if (authorization.owner != owner || authorization.account != address(this)) revert InvalidSignature();
        if (authorization.paymentType != _DIRECT_PAYMENT) revert InvalidSignature();
        if (!allowedTokens[authorization.token]) revert TokenNotAllowed(authorization.token);
        if (authorization.recipient == address(0)) revert InvalidRecipient();
        if (authorization.amount == 0) revert InvalidAmount();
        _validateNonceAndDeadline(authorization.nonce, authorization.deadline, _DIRECT_DEADLINE_WINDOW);
        _requireTokenBalance(authorization.token, authorization.amount);

        authorizationHash = _hashDirectAuthorization(authorization);
        if (_recover(authorizationHash, signature) != owner) revert InvalidSignature();
    }

    function _validateRouteAuthorization(
        RoutePaymentAuthorization calldata authorization,
        bytes calldata routeCalldata,
        bytes calldata signature
    ) private view returns (bytes32 authorizationHash) {
        if (authorization.owner != owner || authorization.account != address(this)) {
            revert InvalidSignature();
        }
        if (authorization.paymentType != _ROUTE_PAYMENT) revert InvalidSignature();
        if (!allowedTokens[authorization.sourceToken]) revert TokenNotAllowed(authorization.sourceToken);
        if (authorization.recipient == address(0)) revert InvalidRecipient();
        if (authorization.destinationChainId == 0) revert InvalidDestinationChain();
        if (authorization.destinationToken == address(0)) revert InvalidDestinationToken();
        if (authorization.maxAmountIn == 0 || authorization.minAmountOut == 0) revert InvalidAmount();
        if (!allowedRouteTargets[authorization.routeTarget]) {
            revert RouteTargetNotAllowed(authorization.routeTarget);
        }
        if (authorization.routeCalldataHash != keccak256(routeCalldata)) revert CalldataHashMismatch();
        if (msg.value > authorization.maxNativeFee) {
            revert NativeFeeTooHigh(msg.value, authorization.maxNativeFee);
        }
        _validateNonceAndDeadline(authorization.nonce, authorization.deadline, _ROUTE_DEADLINE_WINDOW);
        _requireTokenBalance(authorization.sourceToken, authorization.maxAmountIn);

        authorizationHash = _hashRouteAuthorization(authorization);
        if (_recover(authorizationHash, signature) != owner) revert InvalidSignature();
    }

    function _validateNonceAndDeadline(uint256 nonce, uint256 deadline, uint256 maximumWindow) private view {
        if (usedNonces[nonce]) revert NonceAlreadyUsed(nonce);
        if (deadline <= block.timestamp) revert DeadlineExpired(deadline);

        uint256 maximum = block.timestamp + maximumWindow;
        if (deadline > maximum) revert DeadlineTooFar(deadline, maximum);
    }

    function _hashDirectAuthorization(DirectPaymentAuthorization calldata authorization)
        private
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                DIRECT_PAYMENT_TYPEHASH,
                authorization.intentIdHash,
                authorization.tenantIdHash,
                authorization.paymentType,
                authorization.owner,
                authorization.account,
                authorization.token,
                authorization.recipient,
                authorization.amount,
                authorization.nonce,
                authorization.deadline,
                authorization.purposeHash
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function _hashRouteAuthorization(RoutePaymentAuthorization calldata authorization) private view returns (bytes32) {
        uint256[18] memory words;
        words[0] = uint256(ROUTE_PAYMENT_TYPEHASH);
        words[1] = uint256(authorization.intentIdHash);
        words[2] = uint256(authorization.tenantIdHash);
        words[3] = uint256(authorization.paymentType);
        words[4] = uint256(uint160(authorization.owner));
        words[5] = uint256(uint160(authorization.account));
        words[6] = uint256(uint160(authorization.sourceToken));
        words[7] = authorization.maxAmountIn;
        words[8] = authorization.destinationChainId;
        words[9] = uint256(uint160(authorization.destinationToken));
        words[10] = uint256(uint160(authorization.recipient));
        words[11] = authorization.minAmountOut;
        words[12] = uint256(uint160(authorization.routeTarget));
        words[13] = uint256(authorization.routeCalldataHash);
        words[14] = authorization.maxNativeFee;
        words[15] = authorization.nonce;
        words[16] = authorization.deadline;
        words[17] = uint256(authorization.purposeHash);
        bytes32 structHash = keccak256(abi.encode(words));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address signer) {
        if (signature.length != 65) revert InvalidSignature();

        bytes memory signatureCopy = signature;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signatureCopy, 32))
            s := mload(add(signatureCopy, 64))
        }
        v = uint8(signatureCopy[64]);
        if (v != 27 && v != 28) revert InvalidSignature();
        if (uint256(r) == 0) revert InvalidSignature();
        if (uint256(s) == 0 || uint256(s) > _SECP256K1_N_HALF) revert InvalidSignature();
        signer = ecrecover(digest, v, r, s);
    }

    function _requireTokenBalance(address token, uint256 required) private view {
        uint256 available = _tokenBalanceOf(token, address(this));
        if (available < required) revert InsufficientTokenBalance(token, required, available);
    }

    function _tokenBalanceOf(address token, address account) private view returns (uint256 balance) {
        (bool success, bytes memory data) = token.staticcall(abi.encodeWithSelector(IERC20.balanceOf.selector, account));
        if (!success || data.length < 32) revert ExternalCallFailed(data);
        balance = abi.decode(data, (uint256));
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        _requireOptionalReturn(success, data);
    }

    function _safeApprove(address token, address spender, uint256 amount) private {
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.approve.selector, spender, amount));
        _requireOptionalReturn(success, data);
    }

    function _requireOptionalReturn(bool success, bytes memory data) private pure {
        if (!success || (data.length != 0 && (data.length != 32 || !abi.decode(data, (bool))))) {
            revert ExternalCallFailed(data);
        }
    }
}

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}
