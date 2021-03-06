const { BN, shouldFail, time, balance } = require('openzeppelin-test-helpers');

const { buildCreate2Address } = require('./helpers/create2');
const { signMessage } = require('./helpers/sign');

const Create2 = artifacts.require('Create2');
const QuickWalletFactory = artifacts.require('QuickWalletFactory');
const QuickWallet = artifacts.require('QuickWallet');
const ERC20Mock = artifacts.require('ERC20Mock');
const Receiver = artifacts.require('Receiver');

contract('QuickWallet', function ([_, tokenOwner, walletOwner, relayer, otherAccount]) {
  const walletBytecode = QuickWallet.bytecode;
  const quickWalletCallParameters = ['address', 'bytes', 'uint256', 'address', 'uint256', 'uint256'];

  const encodeTransfer = function (to, value) {
    return web3.eth.abi.encodeFunctionCall({
      name: 'transfer',
      type: 'frunction',
      inputs: [{ type: 'address', name: 'to' }, { type: 'uint256', name: 'value' }],
    }, [to, value]);
  };

  beforeEach(async function () {
    const create2Lib = await Create2.new();
    await QuickWalletFactory.link('Create2', create2Lib.address);
    this.factory = await QuickWalletFactory.new(walletBytecode);
    this.token = await ERC20Mock.new(tokenOwner, 100);

    this.computeWalletAddress = async function (_walletOwner) {
      return buildCreate2Address(this.factory.address, web3.utils.soliditySha3(_walletOwner),
        walletBytecode + web3.eth.abi.encodeParameters(['address'], [_walletOwner]).substring(2)
      );
    };

    this.deployQuickWallet = async function (
      _firstTxTo, _firstTxData, _value, _tokenFee, _feeValue, _walletOwner, _timeLimit = 60
    ) {
      const beforeTime = (await time.latest()) + _timeLimit;
      const walletAddress = await this.computeWalletAddress(_walletOwner);
      const txData = web3.eth.abi.encodeParameters(
        quickWalletCallParameters, [_firstTxTo, _firstTxData, _value, _tokenFee, _feeValue, beforeTime]
      );
      const txSigned = await signMessage(_walletOwner, web3.utils.soliditySha3(walletAddress, txData, 0));
      await this.factory.deployQuickWallet(_walletOwner, txData, txSigned, relayer, { from: relayer });
      return QuickWallet.at(walletAddress);
    };
  });

  it('should deploy a QuickWallet contract with correct owner and pay fee in tokens', async function () {
    const walletAddress = await this.computeWalletAddress(walletOwner);
    await this.token.transfer(walletAddress, 50, { from: tokenOwner });
    const sendTokensData = encodeTransfer(otherAccount, 10);
    const wallet = await this.deployQuickWallet(
      this.token.address, sendTokensData, 0, this.token.address, 1, walletOwner
    );

    (await this.token.balanceOf(tokenOwner)).should.be.bignumber.equal(new BN(50));
    (await this.token.balanceOf(relayer)).should.be.bignumber.equal(new BN(1));
    (await this.token.balanceOf(otherAccount)).should.be.bignumber.equal(new BN(10));
    (await this.token.balanceOf(wallet.address)).should.be.bignumber.equal(new BN(39));
    (await wallet.owner()).should.be.equal(walletOwner);
  });

  it('should deploy a QuickWallet contract with correct owner and pay fee in eth', async function () {
    const walletAddress = await this.computeWalletAddress(walletOwner);
    await web3.eth.sendTransaction({ from: tokenOwner, to: walletAddress, value: 100 });
    const sendTokensData = encodeTransfer(otherAccount, 10);

    const balanceTrackerOtherAccount = await balance.tracker(otherAccount);
    const balanceTrackerWallet = await balance.tracker(walletAddress);
    await this.deployQuickWallet(walletAddress, sendTokensData, 0, walletAddress, 1, walletOwner);

    (await balanceTrackerOtherAccount.delta()).should.be.bignumber.equal(new BN(10));
    (await balanceTrackerWallet.get()).should.be.bignumber.equal(new BN(89));
  });

  it('should transfer tokens and pay fee in tokens', async function () {
    const walletAddress = await this.computeWalletAddress(walletOwner);
    await this.token.transfer(walletAddress, 50, { from: tokenOwner });
    const sendTokensData = encodeTransfer(otherAccount, 10);
    const wallet = await this.deployQuickWallet(
      this.token.address, sendTokensData, 0, this.token.address, 1, walletOwner
    );

    const beforeTime = (await time.latest()) + 60;
    const sendMoreTokensQuickTxData = web3.eth.abi.encodeParameters(
      quickWalletCallParameters, [this.token.address, sendTokensData, 0, this.token.address, 1, beforeTime]
    );
    const sendMoreTokensQuickTxDataSig = await signMessage(walletOwner,
      web3.utils.soliditySha3(walletAddress, sendMoreTokensQuickTxData, 1)
    );
    await wallet.call(
      sendMoreTokensQuickTxData, sendMoreTokensQuickTxDataSig, relayer, { from: relayer }
    );

    (await this.token.balanceOf(tokenOwner)).should.be.bignumber.equal(new BN(50));
    (await this.token.balanceOf(relayer)).should.be.bignumber.equal(new BN(2));
    (await this.token.balanceOf(otherAccount)).should.be.bignumber.equal(new BN(20));
    (await this.token.balanceOf(wallet.address)).should.be.bignumber.equal(new BN(28));
  });

  it('should execute call with value in receiver', async function () {
    const walletAddress = await this.computeWalletAddress(walletOwner);
    const receiver = await Receiver.new();
    await web3.eth.sendTransaction({ from: tokenOwner, to: walletAddress, value: 100 });
    const receiverData = web3.eth.abi.encodeFunctionCall({
      name: 'showMessage',
      type: 'frunction',
      inputs: [{ type: 'string', name: 'text' }],
    }, ['test']);
    const wallet = await this.deployQuickWallet(
      receiver.address, receiverData, 10, walletAddress, 1, walletOwner
    );

    const beforeTime = (await time.latest()) + 60;
    const receiverQuickTxData = web3.eth.abi.encodeParameters(
      quickWalletCallParameters, [receiver.address, receiverData, 10, wallet.address, 1, beforeTime]
    );
    const receiverQuickTxDataSig = await signMessage(walletOwner,
      web3.utils.soliditySha3(walletAddress, receiverQuickTxData, 1)
    );
    await wallet.call(
      receiverQuickTxData, receiverQuickTxDataSig, relayer, { from: relayer }
    );

    (await web3.eth.getBalance(receiver.address)).should.equal('20');
    (await web3.eth.getBalance(wallet.address)).should.equal('78');
  });

  it('should protect a token transfer against replay', async function () {
    const walletAddress = await this.computeWalletAddress(walletOwner);
    await this.token.transfer(walletAddress, 50, { from: tokenOwner });
    const sendTokensData = encodeTransfer(otherAccount, 10);
    const wallet = await this.deployQuickWallet(
      this.token.address, sendTokensData, 0, this.token.address, 1, walletOwner
    );

    const beforeTime = (await time.latest()) + 10;
    const sendMoreTokensQuickTxData = web3.eth.abi.encodeParameters(
      quickWalletCallParameters, [this.token.address, sendTokensData, 0, this.token.address, 1, beforeTime]
    );
    const sendMoreTokensQuickTxDataSig = await signMessage(walletOwner,
      web3.utils.soliditySha3(walletAddress, sendMoreTokensQuickTxData, 1)
    );
    await wallet.call(sendMoreTokensQuickTxData, sendMoreTokensQuickTxDataSig, relayer, { from: relayer });

    await shouldFail.reverting(
      wallet.call(sendMoreTokensQuickTxData, sendMoreTokensQuickTxDataSig, relayer, { from: relayer })
    );

    (await this.token.balanceOf(tokenOwner)).should.be.bignumber.equal(new BN(50));
    (await this.token.balanceOf(relayer)).should.be.bignumber.equal(new BN(2));
    (await this.token.balanceOf(otherAccount)).should.be.bignumber.equal(new BN(20));
    (await this.token.balanceOf(wallet.address)).should.be.bignumber.equal(new BN(28));
  });

  it('should protect a token transfer against tx replay with different fees in and time', async function () {
    const walletAddress = await this.computeWalletAddress(walletOwner);
    await this.token.transfer(walletAddress, 50, { from: tokenOwner });
    const sendTokensData = encodeTransfer(otherAccount, 10);
    const wallet = await this.deployQuickWallet(
      this.token.address, sendTokensData, 0, this.token.address, 1, walletOwner
    );

    const beforeTimeInHighFee = (await time.latest()) + 10;
    const sendTokensQuickTxDataHighfee = web3.eth.abi.encodeParameters(
      quickWalletCallParameters, [this.token.address, sendTokensData, 0, this.token.address, 3, beforeTimeInHighFee]
    );
    const sendTokensQuickTxDataHighfeeSig = await signMessage(walletOwner,
      web3.utils.soliditySha3(walletAddress, sendTokensQuickTxDataHighfee, 1)
    );

    const beforeTimeInLowFee = (await time.latest()) + 30;
    const sendTokensQuickTxDataLowFee = web3.eth.abi.encodeParameters(
      quickWalletCallParameters, [this.token.address, sendTokensData, 0, this.token.address, 1, beforeTimeInLowFee]
    );
    const sendTokensQuickTxDataLowfeeSig = await signMessage(walletOwner,
      web3.utils.soliditySha3(walletAddress, sendTokensQuickTxDataLowFee, 1)
    );

    await wallet.call(
      sendTokensQuickTxDataHighfee, sendTokensQuickTxDataHighfeeSig, relayer, { from: relayer }
    );

    await shouldFail.reverting(
      wallet.call(
        sendTokensQuickTxDataLowFee, sendTokensQuickTxDataLowfeeSig, relayer, { from: relayer }
      )
    );

    (await this.token.balanceOf(tokenOwner)).should.be.bignumber.equal(new BN(50));
    (await this.token.balanceOf(relayer)).should.be.bignumber.equal(new BN(4));
    (await this.token.balanceOf(otherAccount)).should.be.bignumber.equal(new BN(20));
    (await this.token.balanceOf(wallet.address)).should.be.bignumber.equal(new BN(26));
  });
});
