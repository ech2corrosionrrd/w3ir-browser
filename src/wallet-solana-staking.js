'use strict';
// Solana Stake Program (стейкінг SOL): делегування валідаторам, перегляд стейк-акаунтів,
// деактивація та виведення SOL. Ключі формуються в ізоляції та не кешуються.

function installStaking(proto, { S, RpcError, clip, unauthorized }) {
  proto.solStakeAccounts = async function (address) {
    if (!address || !S.isAddress(address)) return [];
    const cluster = this.solCluster();
    const res = await this.solRpc(cluster, 'getParsedProgramAccounts', [
      S.PROGRAMS.STAKE,
      {
        commitment: 'confirmed',
        encoding: 'jsonParsed',
        filters: [{ memcmp: { offset: 44, bytes: address } }],
      },
    ], 10000, { fallbackOnError: true }).catch(() => []);
    if (!Array.isArray(res)) return [];
    return res.map(item => {
      const data = item.account && item.account.data;
      const parsed = data && data.parsed;
      const info = parsed && parsed.info;
      const stake = info && info.stake;
      const meta = info && info.meta;
      const delegation = stake && stake.delegation;
      return {
        pubkey: item.pubkey,
        lamports: item.account.lamports,
        sol: S.sol(item.account.lamports),
        staker: meta && meta.authorized && meta.authorized.staker,
        withdrawer: meta && meta.authorized && meta.authorized.withdrawer,
        voter: delegation && delegation.voter,
        delegatedSol: delegation ? S.sol(delegation.stake) : '0',
        activationEpoch: delegation && delegation.activationEpoch,
        deactivationEpoch: delegation && delegation.deactivationEpoch,
        state: (parsed && parsed.type) || 'unknown',
      };
    });
  };

  proto.solVoteAccounts = async function () {
    const cluster = this.solCluster();
    const res = await this.solRpc(cluster, 'getVoteAccounts', [{ commitment: 'confirmed' }], 10000, { fallbackOnError: true }).catch(() => ({ current: [] }));
    const current = Array.isArray(res.current) ? res.current : [];
    return current
      .sort((a, b) => (b.activatedStake || 0) - (a.activatedStake || 0))
      .slice(0, 50)
      .map(v => ({
        votePubkey: v.votePubkey,
        nodePubkey: v.nodePubkey,
        activatedStake: S.sol(v.activatedStake),
        commission: v.commission,
      }));
  };

  proto.solStakeDelegate = async function (win, sameTab, { index, votePubkey, amount, speed }) {
    const s = this.data();
    if (!s) throw unauthorized('Гаманець не створено');
    const from = this.solAccount(index);
    if (!votePubkey || !S.isAddress(votePubkey)) throw new RpcError(-32602, 'Некоректна адреса валідатора.');
    let lamports;
    try {
      lamports = S.parseSol(amount);
      if (lamports <= 0n) throw new Error('Сума має бути більшою за нуль');
    } catch {
      throw new RpcError(-32602, 'Некоректна сума стейкінгу SOL.');
    }

    const cluster = this.solCluster();
    const RENT_EXEMPT_STAKE = 2282880n;
    const totalLamports = lamports + RENT_EXEMPT_STAKE;

    let bh;
    try {
      bh = (await this.solRpc(cluster, 'getLatestBlockhash', [{ commitment: 'confirmed' }], 10000, { fallbackOnError: true })).value.blockhash;
    } catch (e) {
      throw new RpcError(-32000, `Не вдалося отримати blockhash: ${clip(e.message, 160)}`);
    }

    const stakeKp = S.generateKeypair();
    const fee = await this.solPriorityFee(cluster, speed, 1000);
    const instructions = [
      ...fee.instructions,
      S.ixSystemCreateAccount({
        from,
        newAccount: stakeKp.address,
        lamports: totalLamports,
        space: 200,
        programId: S.PROGRAMS.STAKE,
      }),
      S.ixStakeInitialize({
        stakeAccount: stakeKp.address,
        staker: from,
        withdrawer: from,
      }),
      S.ixStakeDelegate({
        stakeAccount: stakeKp.address,
        voteAccount: votePubkey,
        authorizedPubkey: from,
      }),
    ];

    const message = S.compileMessage({ feePayer: from, instructions, blockhash: bh });
    const kpSig = S.sign(stakeKp.secret, message.serialize());

    const r = await this._solSignTransactions(win, 'w3ir://wallet', {
      transactions: [S.unsignedWire(message).toString('base64')],
    }, sameTab, true, {
      address: from,
      action: 'Стейкінг SOL (делегування)',
      extraSigners: [
        { address: stakeKp.address, signature: kpSig.toString('base64') },
      ],
    });
    return { signature: r.signature, stakeAccount: stakeKp.address };
  };

  proto.solStakeDeactivate = async function (win, sameTab, { index, stakeAccount, speed }) {
    const s = this.data();
    if (!s) throw unauthorized('Гаманець не створено');
    const from = this.solAccount(index);
    if (!stakeAccount || !S.isAddress(stakeAccount)) throw new RpcError(-32602, 'Некоректна адреса стейк-акаунта.');

    const cluster = this.solCluster();
    let bh;
    try {
      bh = (await this.solRpc(cluster, 'getLatestBlockhash', [{ commitment: 'confirmed' }], 10000, { fallbackOnError: true })).value.blockhash;
    } catch (e) {
      throw new RpcError(-32000, `Не вдалося отримати blockhash: ${clip(e.message, 160)}`);
    }

    const fee = await this.solPriorityFee(cluster, speed, 1000);
    const instructions = [
      ...fee.instructions,
      S.ixStakeDeactivate({
        stakeAccount,
        authorizedPubkey: from,
      }),
    ];

    const message = S.compileMessage({ feePayer: from, instructions, blockhash: bh });
    const r = await this._solSignTransactions(win, 'w3ir://wallet', {
      transactions: [S.unsignedWire(message).toString('base64')],
    }, sameTab, true, {
      address: from,
      action: 'Деактивація стейкінгу SOL',
    });
    return { signature: r.signature };
  };

  proto.solStakeWithdraw = async function (win, sameTab, { index, stakeAccount, lamports, speed }) {
    const s = this.data();
    if (!s) throw unauthorized('Гаманець не створено');
    const from = this.solAccount(index);
    if (!stakeAccount || !S.isAddress(stakeAccount)) throw new RpcError(-32602, 'Некоректна адреса стейк-акаунта.');

    let withdrawLamports = 0n;
    if (lamports !== undefined && lamports !== null && lamports !== '' && lamports !== 0) {
      try {
        withdrawLamports = BigInt(lamports);
      } catch {
        throw new RpcError(-32602, 'Некоректна кількість lamports для виведення.');
      }
    }
    if (withdrawLamports <= 0n) {
      const cluster = this.solCluster();
      const bal = await this.solRpc(cluster, 'getBalance', [stakeAccount, { commitment: 'confirmed' }], 8000).catch(() => ({ value: 0 }));
      withdrawLamports = BigInt(bal.value || 0);
    }
    if (withdrawLamports <= 0n) throw new RpcError(-32602, 'Немає коштів для виведення зі стейку.');

    const cluster = this.solCluster();
    let bh;
    try {
      bh = (await this.solRpc(cluster, 'getLatestBlockhash', [{ commitment: 'confirmed' }], 10000, { fallbackOnError: true })).value.blockhash;
    } catch (e) {
      throw new RpcError(-32000, `Не вдалося отримати blockhash: ${clip(e.message, 160)}`);
    }

    const fee = await this.solPriorityFee(cluster, speed, 1000);
    const instructions = [
      ...fee.instructions,
      S.ixStakeWithdraw({
        stakeAccount,
        to: from,
        authorizedPubkey: from,
        lamports: withdrawLamports,
      }),
    ];

    const message = S.compileMessage({ feePayer: from, instructions, blockhash: bh });
    const r = await this._solSignTransactions(win, 'w3ir://wallet', {
      transactions: [S.unsignedWire(message).toString('base64')],
    }, sameTab, true, {
      address: from,
      action: 'Виведення SOL зі стейку',
    });
    return { signature: r.signature };
  };
}

module.exports = { installStaking };
