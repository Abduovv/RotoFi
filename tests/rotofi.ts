import { before, describe, it } from "node:test";
import assert from "node:assert";

import {
  ROTOFI_PROGRAM_ADDRESS,
  getCreateCycleInstructionAsync,
  getJoinCycleInstructionAsync,
  getSubmitContributionInstruction,
  getTriggerPayoutInstruction,
  getExitCycleInstruction,
  getCloseCycleInstructionAsync,
  parseCreateCycleInstruction,
  parseJoinCycleInstruction,
  parseSubmitContributionInstruction,
  parseTriggerPayoutInstruction,
  parseExitCycleInstruction,
  parseCloseCycleInstruction,
  // account fetchers
  fetchCycleAccount,
  fetchMaybeCycleAccount,
  fetchMaybeMemberAccount,
} from "../dist/js-client";

// @solana/kit types & helpers, solana-kite connection utils
import {
  address,
  type Address,
  type Lamports,
  addSignersToInstruction,
} from "@solana/kit";
import { connect, Connection, SOL } from "solana-kite";

const asBig = (n: number) => BigInt(n);
const ZERO_LAMPORTS = 0n as unknown as Lamports;
const ONE_SOL = SOL as unknown as Lamports;

async function wait(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

describe("rotofi end-to-end", () => {
  let conn: Connection;

  before(() => {
    conn = connect("localnet");
  });

  it("runs full lifecycle with 2 members: create → join → contribute → payouts → close", async () => {
    // Wallets
    const mintAuthority = await conn.createWallet({ airdropAmount: ONE_SOL });
    const organizer = await conn.createWallet({ airdropAmount: ONE_SOL });
    const memberA = await conn.createWallet({ airdropAmount: ONE_SOL });
    const memberB = await conn.createWallet({ airdropAmount: ONE_SOL });

    // Create a local test mint (Fake USDT)
    const mint = await conn.createTokenMint({
      mintAuthority,
      decimals: 6,
      name: "Fake USDT",
      symbol: "fUSDT",
      uri: "https://example.com/fusdt.json",
    });

    // Derive token accounts and fund organizer + members
    const organizerAta = await conn.getTokenAccountAddress(organizer.address, mint);
    const memberAAta = await conn.getTokenAccountAddress(memberA.address, mint);
    const memberBAta = await conn.getTokenAccountAddress(memberB.address, mint);

    // Mint enough tokens for stake + contributions + collateral
    const M = 1_000_000n; // 1.0 fUSDT (6 decimals)
    await conn.mintTokens(mint, mintAuthority, 10_000n * M, organizer.address);
    await conn.mintTokens(mint, mintAuthority, 10_000n * M, memberA.address);
    await conn.mintTokens(mint, mintAuthority, 10_000n * M, memberB.address);

    // Create cycle config — simple timing to allow fast tests
    const amountPerUser = 1_000_000n; // 1 fUSDT per round
    const maxParticipants = 2;
    const contributionInterval = 2n; // seconds per round
    const contributionsPerPayout = 1; // payout every round
    const roundCount = 2; // two payouts total
    const nonces = 1;

    // Build create_cycle
    let createIx = await getCreateCycleInstructionAsync({
      organizer,
      tokenMint: mint,
      amountPerUser,
      maxParticipants,
      contributionInterval,
      contributionsPerPayout,
      roundCount,
      nonces,
    });
    createIx = addSignersToInstruction([organizer], createIx);

    // Send create_cycle
    let sig = await conn.sendTransactionFromInstructions({
      feePayer: organizer,
      instructions: [createIx],
    });
    assert.ok(sig.length > 0);

    // Derive cycle PDA from parsed instruction
    const parsedCreate = parseCreateCycleInstruction(createIx);
    const cycle = parsedCreate.accounts.cycle.address as Address;

    // Verify initial cycle state
    let cycleAcc = await fetchCycleAccount(conn.rpc, cycle);
    assert.strictEqual(cycleAcc.data.isActive, false);
    assert.strictEqual(Number(cycleAcc.data.currentParticipants), 0);

    // Join member A
    let cycleTokenAccount = await conn.getTokenAccountAddress(cycle, mint);
    let joinA = await getJoinCycleInstructionAsync({
      member: memberA,
      cycle,
      cycleTokenAccount,
      memberTokenAccount: memberAAta,
      organizer: organizer.address,
    });
    joinA = addSignersToInstruction([memberA], joinA);

    sig = await conn.sendTransactionFromInstructions({ feePayer: memberA, instructions: [joinA] });
    assert.ok(sig.length > 0);

    // Join member B (activates the cycle)
    let joinB = await getJoinCycleInstructionAsync({
      member: memberB,
      cycle,
      cycleTokenAccount,
      memberTokenAccount: memberBAta,
      organizer: organizer.address,
    });
    joinB = addSignersToInstruction([memberB], joinB);
    sig = await conn.sendTransactionFromInstructions({ feePayer: memberB, instructions: [joinB] });
    assert.ok(sig.length > 0);

    // Check cycle active and participants = 2
    cycleAcc = await fetchCycleAccount(conn.rpc, cycle);
    assert.strictEqual(cycleAcc.data.isActive, true);
    assert.strictEqual(Number(cycleAcc.data.currentParticipants), 2);

    // Member accounts (for later payouts)
    const parsedJoinA = parseJoinCycleInstruction(joinA);
    const parsedJoinB = parseJoinCycleInstruction(joinB);
    const memberAAccount = parsedJoinA.accounts.memberAccount.address as Address;
    const memberBAccount = parsedJoinB.accounts.memberAccount.address as Address;

    // Round 1: contributions from A and B
    let submitA = getSubmitContributionInstruction({
      member: memberA,
      cycle,
      memberAccount: memberAAccount,
      cycleTokenAccount,
      memberTokenAccount: memberAAta,
      organizer: organizer.address,
    });
    submitA = addSignersToInstruction([memberA], submitA);

    let submitB = getSubmitContributionInstruction({
      member: memberB,
      cycle,
      memberAccount: memberBAccount,
      cycleTokenAccount,
      memberTokenAccount: memberBAta,
      organizer: organizer.address,
    });
    submitB = addSignersToInstruction([memberB], submitB);

    sig = await conn.sendTransactionFromInstructions({ feePayer: memberA, instructions: [submitA] });
    assert.ok(sig.length > 0);
    sig = await conn.sendTransactionFromInstructions({ feePayer: memberB, instructions: [submitB] });
    assert.ok(sig.length > 0);

    // Wait for payout window
    await new Promise((r) => setTimeout(r, 2100));

    // Trigger payout for first recipient in order (member A joined first)
    let trigger1 = getTriggerPayoutInstruction({
      organizer,
      cycle,
      cycleTokenAccount,
      recipientTokenAccount: memberAAta,
      organizerTokenAccount: organizerAta,
      memberAccount: memberAAccount,
      recipient: memberA.address,
    });
    trigger1 = addSignersToInstruction([organizer], trigger1);
    sig = await conn.sendTransactionFromInstructions({ feePayer: organizer, instructions: [trigger1] });
    assert.ok(sig.length > 0);

    // Round 2: contributions again
    submitA = getSubmitContributionInstruction({
      member: memberA,
      cycle,
      memberAccount: memberAAccount,
      cycleTokenAccount,
      memberTokenAccount: memberAAta,
      organizer: organizer.address,
    });
    submitA = addSignersToInstruction([memberA], submitA);

    submitB = getSubmitContributionInstruction({
      member: memberB,
      cycle,
      memberAccount: memberBAccount,
      cycleTokenAccount,
      memberTokenAccount: memberBAta,
      organizer: organizer.address,
    });
    submitB = addSignersToInstruction([memberB], submitB);

    sig = await conn.sendTransactionFromInstructions({ feePayer: memberA, instructions: [submitA] });
    assert.ok(sig.length > 0);
    sig = await conn.sendTransactionFromInstructions({ feePayer: memberB, instructions: [submitB] });
    assert.ok(sig.length > 0);

    await new Promise((r) => setTimeout(r, 2100));

    // Trigger payout for second recipient (member B)
    let trigger2 = getTriggerPayoutInstruction({
      organizer,
      cycle,
      cycleTokenAccount,
      recipientTokenAccount: memberBAta,
      organizerTokenAccount: organizerAta,
      memberAccount: memberBAccount,
      recipient: memberB.address,
    });
    trigger2 = addSignersToInstruction([organizer], trigger2);
    sig = await conn.sendTransactionFromInstructions({ feePayer: organizer, instructions: [trigger2] });
    assert.ok(sig.length > 0);

    // After two payouts, cycle should be inactive
    cycleAcc = await fetchCycleAccount(conn.rpc, cycle);
    assert.strictEqual(cycleAcc.data.isActive, false);

    // Close cycle and refund organizer stake
    const closeIx = await getCloseCycleInstructionAsync({
      organizer,
      cycle,
      cycleTokenAccount,
      organizerTokenAccount: organizerAta,
      recipient: organizer.address,
    });
    const closeWithSigner = addSignersToInstruction([organizer], closeIx);
    sig = await conn.sendTransactionFromInstructions({ feePayer: organizer, instructions: [closeWithSigner] });
    assert.ok(sig.length > 0);

    // Cycle account may be closed or still fetchable; at least it's inactive earlier
    const maybeCycle = await fetchMaybeCycleAccount(conn.rpc, cycle);
    assert.ok(!maybeCycle.exists || maybeCycle.data.isActive === false);
  });

  it("supports early exit before start (collateral refund)", async () => {
    const mintAuthority = await conn.createWallet({ airdropAmount: ONE_SOL });
    const organizer = await conn.createWallet({ airdropAmount: ONE_SOL });
    const member = await conn.createWallet({ airdropAmount: ONE_SOL });

    const mint = await conn.createTokenMint({
      mintAuthority,
      decimals: 6,
      name: "Fake USDT",
      symbol: "fUSDT",
      uri: "https://example.com/fusdt.json",
    });
    const memberAta = await conn.getTokenAccountAddress(member.address, mint);
    const organizerAta = await conn.getTokenAccountAddress(organizer.address, mint);

    await conn.mintTokens(mint, mintAuthority, 10_000_000n, organizer.address);
    await conn.mintTokens(mint, mintAuthority, 10_000_000n, member.address);

    const amountPerUser = 1_000_000n;
    const nonces = 2;

    let createIx = await getCreateCycleInstructionAsync({
      organizer,
      tokenMint: mint,
      amountPerUser,
      maxParticipants: 2,
      contributionInterval: 5n,
      contributionsPerPayout: 1,
      roundCount: 1,
      nonces,
    });
    createIx = addSignersToInstruction([organizer], createIx);
    await conn.sendTransactionFromInstructions({ feePayer: organizer, instructions: [createIx] });

    const cycle = parseCreateCycleInstruction(createIx).accounts.cycle.address as Address;
    const cycleAta = await conn.getTokenAccountAddress(cycle, mint);

    let joinIx = await getJoinCycleInstructionAsync({
      member,
      cycle,
      cycleTokenAccount: cycleAta,
      memberTokenAccount: memberAta,
      organizer: organizer.address,
    });
    joinIx = addSignersToInstruction([member], joinIx);
    await conn.sendTransactionFromInstructions({ feePayer: member, instructions: [joinIx] });

    // Exit before any round starts
    let exitIx = getExitCycleInstruction({
      member,
      cycle,
      memberAccount: parseJoinCycleInstruction(joinIx).accounts.memberAccount.address as Address,
      cycleTokenAccount: cycleAta,
      memberTokenAccount: memberAta,
      organizer: organizer.address,
    });
    exitIx = addSignersToInstruction([member], exitIx);
    const sig = await conn.sendTransactionFromInstructions({ feePayer: member, instructions: [exitIx] });
    assert.ok(sig.length > 0);

    // Member account should now be closed; maybe fetch returns not exists
    const maybeMember = await fetchMaybeMemberAccount(
      conn.rpc,
      parseJoinCycleInstruction(joinIx).accounts.memberAccount.address as Address
    );
    assert.ok(!maybeMember.exists);
  });
});