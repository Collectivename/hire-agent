import "server-only";
import { createHash } from "node:crypto";
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
} from "@solana-program/token-2022";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  createNoopSigner,
  createTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getArrayDecoder,
  getArrayEncoder,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getI64Decoder,
  getI64Encoder,
  getStructDecoder,
  getStructEncoder,
  getU16Encoder,
  getU32Decoder,
  getU32Encoder,
  getU64Decoder,
  getU64Encoder,
  getProgramDerivedAddress,
  getU8Decoder,
  getU8Encoder,
  getUtf8Encoder,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
} from "@solana/kit";
import bs58 from "bs58";
import { PublicKey, VersionedTransaction, type VersionedMessage } from "@solana/web3.js";
import { hireConnection } from "./host";
import { canonicalPubkey } from "./crypto";
import { AgentsError } from "./errors";
import { SOLANA_DEVNET, type Job } from "./jobs";
import { agentStore } from "./store";

const PROGRAM_ID = "CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ED25519_PROGRAM = "Ed25519SigVerify111111111111111111111111111";
const INSTRUCTIONS_SYSVAR = "Sysvar1nstructions1111111111111111111111111";
const MAINNET_TREASURY = "Cs2zdfUNonRdRGsiZUQQLdTxzxVvJZmgiX2mpLYKuEqP";
const DEVNET_TREASURY = "4zTeC5mVqWLruDexgU2mV66p9t5vCA9JyiZqdGDUspap";
const VOUCHER_MAGIC = [86, 1];
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const RENT_SYSVAR = "SysvarRent111111111111111111111111111111111";

/**
 * The channel payee is the seller agent wallet. The program rejects an open
 * whose payee equals the payer (error 2001, PayerPayeeMustDiffer), and
 * settle_and_seal must be signed by the payee. The seller agent signs the
 * settle outside this server, the same way agent wallets sign action
 * transactions, and the server verifies that signature before broadcast. The
 * settled amount comes only from a voucher signed by the buyer owner and the
 * recipients are committed in the channel at deposit time, so the payee
 * signature cannot move funds anywhere else.
 */

export type PreparedChannelTransaction = {
  transaction: string;
  blockhash: string;
  lastValidBlockHeight: string;
};

type OpenChannel = {
  discriminator: number;
  status: number;
  deposit: bigint;
  settlement: { settled: bigint; payoutWatermark: bigint };
  closureStartedAt: bigint;
  gracePeriod: number;
  distributionHash: ArrayLike<number>;
  payer: string;
  payee: string;
  authorizedSigner: string;
  mint: string;
  rentPayer: string;
};

const channelDecoder = getStructDecoder([
  ["discriminator", getU8Decoder()],
  ["version", getU8Decoder()],
  ["bump", getU8Decoder()],
  ["status", getU8Decoder()],
  ["salt", getU64Decoder()],
  ["deposit", getU64Decoder()],
  ["settlement", getStructDecoder([
    ["settled", getU64Decoder()],
    ["payoutWatermark", getU64Decoder()],
  ])],
  ["closureStartedAt", getI64Decoder()],
  ["payerWithdrawnAt", getI64Decoder()],
  ["gracePeriod", getU32Decoder()],
  ["distributionHash", getArrayDecoder(getU8Decoder(), { size: 32 })],
  ["payer", getAddressDecoder()],
  ["payee", getAddressDecoder()],
  ["authorizedSigner", getAddressDecoder()],
  ["mint", getAddressDecoder()],
  ["rentPayer", getAddressDecoder()],
  ["openSlot", getU64Decoder()],
]);

function fail(code: "PAYMENT_INVALID" | "FACILITATOR_UNCONFIGURED", message: string, status: 402 | 503): never {
  throw new AgentsError(code, message, status);
}

function sameBytes(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return false;
  return true;
}

function sellerSplitHash(seller: string): Uint8Array {
  const hash = createHash("sha256");
  const count = Buffer.alloc(4);
  count.writeUInt32LE(1, 0);
  hash.update(count);
  hash.update(Buffer.from(getBase58Encoder().encode(seller)));
  const bps = Buffer.alloc(2);
  bps.writeUInt16LE(10_000, 0);
  hash.update(bps);
  return new Uint8Array(hash.digest());
}

function tokenProgramOf(job: Job): string {
  try {
    const stored = JSON.parse(job.depositPayload) as { accepted?: { extra?: { tokenProgram?: unknown } } };
    const hinted = stored.accepted?.extra?.tokenProgram;
    if (hinted === TOKEN_PROGRAM || hinted === TOKEN_2022) return hinted;
  } catch {
    // The deposit payload is checked by the caller. USDC uses the classic token program.
  }
  return TOKEN_PROGRAM;
}

function treasuryOwner(network: string): string {
  if (network === SOLANA_DEVNET || network === "solana-devnet") return DEVNET_TREASURY;
  return MAINNET_TREASURY;
}

async function readChannel(channelId: string): Promise<OpenChannel | null> {
  const info = await hireConnection().getAccountInfo(new PublicKey(channelId), "confirmed");
  if (!info || info.owner.toBase58() !== PROGRAM_ID) return null;
  try {
    const decoded = channelDecoder.decode(new Uint8Array(info.data)) as unknown as OpenChannel;
    if (decoded.discriminator !== 1) return null;
    return decoded;
  } catch {
    return null;
  }
}

function assertMatchesJob(channel: OpenChannel, job: Job): void {
  const amount = BigInt(job.priceBaseUnits);
  if (channel.deposit !== amount) fail("PAYMENT_INVALID", "The channel deposit does not match the locked price.", 402);
  if (channel.mint !== job.mint) fail("PAYMENT_INVALID", "The channel mint does not match the job.", 402);
  if (channel.payer !== job.buyerOwner || channel.rentPayer !== job.buyerOwner) {
    fail("PAYMENT_INVALID", "The buyer owner has to sign this channel.", 402);
  }
  if (channel.payee !== job.sellerWallet) {
    fail("PAYMENT_INVALID", "The channel payee does not match the seller wallet.", 402);
  }
  if (channel.authorizedSigner !== job.buyerOwner) {
    fail("PAYMENT_INVALID", "The buyer owner has to sign this channel.", 402);
  }
  const expected = sellerSplitHash(job.sellerWallet);
  const actual = new Uint8Array(Array.from(channel.distributionHash));
  if (!sameBytes(actual, expected)) {
    fail("PAYMENT_INVALID", "The channel does not pay the seller wallet.", 402);
  }
}

export function voucherMessage(channelId: string, amount: bigint, expiresAt: bigint): Uint8Array {
  const channel = getAddressEncoder().encode(address(channelId));
  if (channel.byteLength !== 32) fail("PAYMENT_INVALID", "The channel address is invalid.", 402);
  const out = new Uint8Array(50);
  out[0] = VOUCHER_MAGIC[0]!;
  out[1] = VOUCHER_MAGIC[1]!;
  out.set(channel, 2);
  out.set(getU64Encoder().encode(amount), 34);
  out.set(getI64Encoder().encode(expiresAt), 42);
  return out;
}

export function describeVoucher(message: Uint8Array, channelId: string, amount: bigint): void {
  if (message.byteLength !== 50 || message[0] !== VOUCHER_MAGIC[0] || message[1] !== VOUCHER_MAGIC[1]) {
    fail("PAYMENT_INVALID", "The release voucher does not match this channel.", 402);
  }
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  const encoded = getBase58Encoder().encode(channelId);
  if (!sameBytes(message.subarray(2, 34), encoded)) {
    fail("PAYMENT_INVALID", "The release voucher does not match this channel.", 402);
  }
  if (view.getBigUint64(34, true) !== amount) {
    fail("PAYMENT_INVALID", "The release voucher does not match the locked price.", 402);
  }
  const expiresAt = view.getBigInt64(42, true);
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (expiresAt <= now || expiresAt > now + BigInt(2_592_000)) {
    fail("PAYMENT_INVALID", "The release voucher has expired.", 402);
  }
}

export async function verifyVoucher(owner: string, message: Uint8Array, signature: Uint8Array): Promise<void> {
  if (signature.byteLength !== 64) fail("PAYMENT_INVALID", "The release voucher signature is invalid.", 402);
  const keyBytes = Uint8Array.from(getBase58Encoder().encode(owner));
  const key = await crypto.subtle.importKey("raw", keyBytes, "Ed25519", false, ["verify"]);
  const messageCopy = new Uint8Array(message);
  const signatureCopy = new Uint8Array(signature);
  const ok = await crypto.subtle.verify("Ed25519", key, signatureCopy, messageCopy);
  if (!ok) fail("PAYMENT_INVALID", "The buyer owner did not sign this release.", 402);
}

function ed25519Instruction(owner: string, message: Uint8Array, signature: Uint8Array): Instruction {
  const signer = getBase58Encoder().encode(owner);
  const publicKeyOffset = 16;
  const signatureOffset = publicKeyOffset + 32;
  const messageOffset = signatureOffset + 64;
  const data = new Uint8Array(messageOffset + message.byteLength);
  const view = new DataView(data.buffer);
  data[0] = 1;
  view.setUint16(2, signatureOffset, true);
  view.setUint16(4, 65535, true);
  view.setUint16(6, publicKeyOffset, true);
  view.setUint16(8, 65535, true);
  view.setUint16(10, messageOffset, true);
  view.setUint16(12, message.byteLength, true);
  view.setUint16(14, 65535, true);
  data.set(signer, publicKeyOffset);
  data.set(signature, signatureOffset);
  data.set(message, messageOffset);
  return { programAddress: address(ED25519_PROGRAM), accounts: [], data };
}

/**
 * The permissionless settle (discriminator 2). Authority is the buyer voucher
 * in the Ed25519 precompile instruction before it, not a transaction signer,
 * so the buyer alone can release a delivery. No payee signature is needed.
 */
function settleOnlyInstruction(channelId: string): Instruction {
  return {
    programAddress: address(PROGRAM_ID),
    accounts: [
      { address: address(channelId), role: AccountRole.WRITABLE },
      { address: address(INSTRUCTIONS_SYSVAR), role: AccountRole.READONLY },
    ],
    data: getStructEncoder([["discriminator", getU8Encoder()]]).encode({ discriminator: 2 }),
  } as Instruction;
}

/** Starts the channel grace period (OPEN to CLOSING). Signed by the payer, who is the buyer owner. */
function requestCloseInstruction(owner: Address, channelId: string, payer: ReturnType<typeof createNoopSigner>): Instruction {
  return {
    programAddress: address(PROGRAM_ID),
    accounts: [
      { address: owner, role: AccountRole.WRITABLE_SIGNER, signer: payer },
      { address: address(channelId), role: AccountRole.WRITABLE },
    ],
    data: getStructEncoder([["discriminator", getU8Encoder()]]).encode({ discriminator: 5 }),
  } as Instruction;
}

/** Permissionless: moves a CLOSING channel to SEALED once the grace period has elapsed. */
function sealInstruction(channelId: string): Instruction {
  return {
    programAddress: address(PROGRAM_ID),
    accounts: [{ address: address(channelId), role: AccountRole.WRITABLE }],
    data: getStructEncoder([["discriminator", getU8Encoder()]]).encode({ discriminator: 6 }),
  } as Instruction;
}

async function distributeInstruction(job: Job, channelId: string, tokenProgram: string, payee: Address): Promise<Instruction> {
  const mint = address(job.mint);
  const token = address(tokenProgram);
  const owner = address(job.buyerOwner);
  const seller = address(job.sellerWallet);
  const treasury = address(treasuryOwner(job.network));
  const [channelAta] = await findAssociatedTokenPda({ mint, owner: address(channelId), tokenProgram: token });
  const [ownerAta] = await findAssociatedTokenPda({ mint, owner, tokenProgram: token });
  const [payeeAta] = await findAssociatedTokenPda({ mint, owner: payee, tokenProgram: token });
  const [sellerAta] = await findAssociatedTokenPda({ mint, owner: seller, tokenProgram: token });
  const [treasuryAta] = await findAssociatedTokenPda({ mint, owner: treasury, tokenProgram: token });
  const eventAuthorityAddress = await eventAuthority();
  const data = getStructEncoder([
    ["discriminator", getU8Encoder()],
    ["recipients", getArrayEncoder(getStructEncoder([
      ["recipient", getAddressEncoder()],
      ["bps", getU16Encoder()],
    ]))],
  ]).encode({
    discriminator: 7,
    recipients: [{ recipient: seller, bps: 10_000 }],
  });
  return {
    programAddress: address(PROGRAM_ID),
    accounts: [
      { address: address(channelId), role: AccountRole.WRITABLE },
      { address: owner, role: AccountRole.WRITABLE },
      { address: owner, role: AccountRole.WRITABLE },
      { address: channelAta, role: AccountRole.WRITABLE },
      { address: ownerAta, role: AccountRole.WRITABLE },
      { address: payeeAta, role: AccountRole.WRITABLE },
      { address: treasuryAta, role: AccountRole.WRITABLE },
      { address: mint, role: AccountRole.READONLY },
      { address: token, role: AccountRole.READONLY },
      { address: eventAuthorityAddress, role: AccountRole.READONLY },
      { address: address(PROGRAM_ID), role: AccountRole.READONLY },
      { address: sellerAta, role: AccountRole.WRITABLE },
    ],
    data,
  };
}

async function eventAuthority(): Promise<Address<string>> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: address(PROGRAM_ID),
    seeds: [getUtf8Encoder().encode("event_authority")],
  });
  return pda;
}

/**
 * Builds the channel open transaction by hand. The x402 upto client cannot be
 * used here: it sets the channel payee to the transaction fee payer, and the
 * program rejects payer == payee (error 2001). Here the buyer owner is payer,
 * rent payer, fee payer, and voucher signer, and the seller agent wallet is
 * the payee and the only paid recipient.
 */
export async function buildOpenTransaction(
  job: Job,
  gracePeriod: number
): Promise<PreparedChannelTransaction & { channelId: string }> {
  const owner = address(job.buyerOwner);
  const payer = createNoopSigner(owner);
  const payee = address(job.sellerWallet);
  const mint = address(job.mint);
  const seller = address(job.sellerWallet);
  const connection = hireConnection();
  const mintInfo = await connection.getAccountInfo(new PublicKey(job.mint), "confirmed");
  const tokenProgramId = mintInfo?.owner.toBase58();
  if (tokenProgramId !== TOKEN_PROGRAM && tokenProgramId !== TOKEN_2022) {
    fail("PAYMENT_INVALID", "The job mint is not a token mint.", 402);
  }
  const token = address(tokenProgramId);
  let slot: number;
  try {
    slot = await connection.getSlot("finalized");
  } catch {
    throw new AgentsError("FACILITATOR_UNCONFIGURED", "The Solana network did not return a slot.", 503);
  }
  const openSlot = BigInt(slot);
  const salt = crypto.getRandomValues(new BigUint64Array(1))[0]!;
  const [channelId] = await getProgramDerivedAddress({
    programAddress: address(PROGRAM_ID),
    seeds: [
      getUtf8Encoder().encode("channel"),
      getAddressEncoder().encode(owner),
      getAddressEncoder().encode(payee),
      getAddressEncoder().encode(mint),
      getAddressEncoder().encode(owner),
      getU64Encoder().encode(salt),
      getU64Encoder().encode(openSlot),
    ],
  });
  const [payerAta] = await findAssociatedTokenPda({ mint, owner, tokenProgram: token });
  const [channelAta] = await findAssociatedTokenPda({ mint, owner: channelId, tokenProgram: token });
  const eventAuthorityAddress = await eventAuthority();
  const data = getStructEncoder([
    ["discriminator", getU8Encoder()],
    ["salt", getU64Encoder()],
    ["deposit", getU64Encoder()],
    ["gracePeriod", getU32Encoder()],
    ["openSlot", getU64Encoder()],
    ["recipients", getArrayEncoder(getStructEncoder([
      ["recipient", getAddressEncoder()],
      ["bps", getU16Encoder()],
    ]))],
  ]).encode({
    discriminator: 1,
    salt,
    deposit: BigInt(job.priceBaseUnits),
    gracePeriod,
    openSlot,
    recipients: [{ recipient: seller, bps: 10_000 }],
  });
  const openInstruction = {
    programAddress: address(PROGRAM_ID),
    accounts: [
      { address: owner, role: AccountRole.WRITABLE_SIGNER, signer: payer },
      { address: owner, role: AccountRole.WRITABLE_SIGNER, signer: payer },
      { address: payee, role: AccountRole.READONLY },
      { address: mint, role: AccountRole.READONLY },
      { address: owner, role: AccountRole.READONLY },
      { address: channelId, role: AccountRole.WRITABLE },
      { address: payerAta, role: AccountRole.WRITABLE },
      { address: channelAta, role: AccountRole.WRITABLE },
      { address: token, role: AccountRole.READONLY },
      { address: address(SYSTEM_PROGRAM), role: AccountRole.READONLY },
      { address: address(RENT_SYSVAR), role: AccountRole.READONLY },
      { address: address(ASSOCIATED_TOKEN_PROGRAM), role: AccountRole.READONLY },
      { address: eventAuthorityAddress, role: AccountRole.READONLY },
      { address: address(PROGRAM_ID), role: AccountRole.READONLY },
    ],
    data,
  } as Instruction;
  const memo = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
  const prepared = await compile(payer, [
    getSetComputeUnitLimitInstruction({ units: 200_000 }),
    getSetComputeUnitPriceInstruction({ microLamports: 1 }),
    openInstruction,
    { programAddress: address(MEMO_PROGRAM), accounts: [], data: getUtf8Encoder().encode(memo) },
  ]);
  return { ...prepared, channelId };
}

async function compile(payer: ReturnType<typeof createNoopSigner>, instructions: Instruction[]): Promise<PreparedChannelTransaction> {
  let latest: { blockhash: string; lastValidBlockHeight: number };
  try {
    latest = await hireConnection().getLatestBlockhash("confirmed");
  } catch {
    throw new AgentsError("FACILITATOR_UNCONFIGURED", "The Solana network did not return a blockhash.", 503);
  }
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (draft) => setTransactionMessageFeePayerSigner(payer, draft),
    (draft) => setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: latest.blockhash as never, lastValidBlockHeight: BigInt(latest.lastValidBlockHeight) },
      draft
    ),
    (draft) => appendTransactionMessageInstructions(instructions, draft)
  );
  const signed = await partiallySignTransactionMessageWithSigners(message);
  return {
    transaction: String(getBase64EncodedWireTransaction(signed)),
    blockhash: latest.blockhash,
    lastValidBlockHeight: String(latest.lastValidBlockHeight),
  };
}

export async function assertDepositLocked(job: Job): Promise<void> {
  if (!canonicalPubkey(job.channelId)) fail("PAYMENT_INVALID", "The channel deposit is not on chain.", 402);
  let channel: OpenChannel | null = null;
  try {
    channel = await readChannel(job.channelId);
  } catch {
    channel = null;
  }
  if (!channel || channel.status !== 0) fail("PAYMENT_INVALID", "The channel deposit is no longer locked.", 402);
  assertMatchesJob(channel, job);
}

function openLocksPrice(vtx: VersionedTransaction, channelId: string, amount: bigint): boolean {
  const keys = vtx.message.staticAccountKeys.map((key) => key.toBase58());
  const programIndex = keys.indexOf(PROGRAM_ID);
  if (programIndex < 0) return false;
  return vtx.message.compiledInstructions.some((ix) => {
    if (ix.programIdIndex !== programIndex) return false;
    const data = Buffer.from(ix.data);
    if (data.length < 17 || data[0] !== 1) return false;
    if (data.readBigUInt64LE(9) !== amount) return false;
    const channelIndex = ix.accountKeyIndexes[5];
    return channelIndex != null && keys[channelIndex] === channelId;
  });
}

export async function buildReleaseTransaction(
  job: Job,
  amount: bigint,
  voucher: { message: Uint8Array; signature: Uint8Array }
): Promise<PreparedChannelTransaction> {
  if (!canonicalPubkey(job.channelId)) fail("PAYMENT_INVALID", "The channel deposit is not on chain.", 402);
  const channel = await readChannel(job.channelId);
  if (!channel || channel.status !== 0) fail("PAYMENT_INVALID", "The channel deposit is not on chain.", 402);
  assertMatchesJob(channel, job);
  if (amount <= BigInt(0) || !voucher) fail("PAYMENT_INVALID", "The buyer owner has to sign the release.", 402);
  const tokenProgram = tokenProgramOf(job);
  const owner = address(job.buyerOwner);
  const payer = createNoopSigner(owner);
  const payee = address(job.sellerWallet);
  const mint = address(job.mint);
  const token = address(tokenProgram);
  const seller = address(job.sellerWallet);
  const treasury = address(treasuryOwner(job.network));
  const [sellerAta] = await findAssociatedTokenPda({ mint, owner: seller, tokenProgram: token });
  const [treasuryAta] = await findAssociatedTokenPda({ mint, owner: treasury, tokenProgram: token });
  const instructions: Instruction[] = [
    getSetComputeUnitLimitInstruction({ units: 400_000 }),
    getCreateAssociatedTokenIdempotentInstruction({
      payer,
      ata: sellerAta,
      owner: seller,
      mint,
      tokenProgram: token,
    }),
    getCreateAssociatedTokenIdempotentInstruction({
      payer,
      ata: treasuryAta,
      owner: treasury,
      mint,
      tokenProgram: token,
    }),
  ];
  describeVoucher(voucher.message, job.channelId, amount);
  await verifyVoucher(job.buyerOwner, voucher.message, voucher.signature);
  instructions.push(ed25519Instruction(job.buyerOwner, voucher.message, voucher.signature));
  // Permissionless settle and distribute: the voucher is the authority, so
  // this whole release is one buyer-signed transaction. Requesting close in
  // the same transaction starts the cleanup clock for the empty channel.
  instructions.push(settleOnlyInstruction(job.channelId));
  instructions.push(await distributeInstruction(job, job.channelId, tokenProgram, payee));
  instructions.push(requestCloseInstruction(owner, job.channelId, payer));
  return compile(payer, instructions);
}

export type RefundStep =
  | { phase: "close"; transaction: string; blockhash: string; lastValidBlockHeight: string }
  | { phase: "wait"; readyAt: number }
  | { phase: "finalize"; transaction: string; blockhash: string; lastValidBlockHeight: string };

/**
 * Refund without the payee: the buyer requests close (starting the grace
 * period), then anyone seals and distributes, which returns the unspent
 * deposit to the buyer. No seller signature exists in this path.
 */
export async function prepareRefundStep(job: Job): Promise<RefundStep> {
  if (!canonicalPubkey(job.channelId)) fail("PAYMENT_INVALID", "The channel deposit is not on chain.", 402);
  const channel = await readChannel(job.channelId);
  if (!channel) fail("PAYMENT_INVALID", "The channel deposit is not on chain.", 402);
  assertMatchesJob(channel, job);
  const owner = address(job.buyerOwner);
  const payer = createNoopSigner(owner);
  if (channel.status === 0) {
    const prepared = await compile(payer, [
      getSetComputeUnitLimitInstruction({ units: 100_000 }),
      requestCloseInstruction(owner, job.channelId, payer),
    ]);
    return { phase: "close", ...prepared };
  }
  if (channel.status === 1) {
    const readyAt = Number((channel.closureStartedAt + BigInt(channel.gracePeriod)) * BigInt(1000));
    if (Date.now() < readyAt) return { phase: "wait", readyAt };
  }
  if (channel.status === 1 || channel.status === 2) {
    const tokenProgram = tokenProgramOf(job);
    const mint = address(job.mint);
    const token = address(tokenProgram);
    const seller = address(job.sellerWallet);
    const treasury = address(treasuryOwner(job.network));
    const [sellerAta] = await findAssociatedTokenPda({ mint, owner: seller, tokenProgram: token });
    const [treasuryAta] = await findAssociatedTokenPda({ mint, owner: treasury, tokenProgram: token });
    const instructions: Instruction[] = [
      getSetComputeUnitLimitInstruction({ units: 400_000 }),
      getCreateAssociatedTokenIdempotentInstruction({ payer, ata: sellerAta, owner: seller, mint, tokenProgram: token }),
      getCreateAssociatedTokenIdempotentInstruction({ payer, ata: treasuryAta, owner: treasury, mint, tokenProgram: token }),
    ];
    if (channel.status === 1) instructions.push(sealInstruction(job.channelId));
    instructions.push(await distributeInstruction(job, job.channelId, tokenProgram, address(job.sellerWallet)));
    const prepared = await compile(payer, instructions);
    return { phase: "finalize", ...prepared };
  }
  fail("PAYMENT_INVALID", "The channel has already closed.", 402);
}

export async function confirmCloseTransaction(job: Job, signature: string): Promise<{ readyAt: number }> {
  if (!canonicalPubkey(job.channelId) || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) {
    fail("PAYMENT_INVALID", "The channel transaction does not match this job.", 402);
  }
  await confirmedSignature(signature, job.buyerOwner, job.channelId);
  const channel = await readChannel(job.channelId);
  if (!channel || channel.status !== 1) {
    fail("PAYMENT_INVALID", "The channel has not started closing.", 402);
  }
  assertMatchesJob(channel, job);
  return { readyAt: Number((channel.closureStartedAt + BigInt(channel.gracePeriod)) * BigInt(1000)) };
}

export async function confirmRefundTransaction(job: Job, signature: string): Promise<void> {
  if (!canonicalPubkey(job.channelId) || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) {
    fail("PAYMENT_INVALID", "The channel transaction does not match this job.", 402);
  }
  await confirmedSignature(signature, job.buyerOwner, job.channelId);
  const channel = await readChannel(job.channelId);
  if (!channel) return; // A fully closed channel is deallocated: the refund already landed.
  if (channel.status !== 3) {
    fail("PAYMENT_INVALID", "The channel has not refunded this payment.", 402);
  }
  assertMatchesJob(channel, job);
}

function accountKeysOf(message: VersionedMessage | { accountKeys: PublicKey[]; instructions: { programIdIndex: number; accounts: number[] }[] }): string[] {
  if ("staticAccountKeys" in message) return message.staticAccountKeys.map((key) => key.toBase58());
  return message.accountKeys.map((key) => key.toBase58());
}

function transactionMentions(message: VersionedMessage | { accountKeys: PublicKey[]; instructions: { programIdIndex: number; accounts: number[] }[] }, channelId: string): boolean {
  const keys = accountKeysOf(message);
  const programIndex = keys.indexOf(PROGRAM_ID);
  const channelIndex = keys.indexOf(channelId);
  if (programIndex < 0 || channelIndex < 0) return false;
  if ("compiledInstructions" in message) {
    return message.compiledInstructions.some((ix) => ix.programIdIndex === programIndex && ix.accountKeyIndexes.includes(channelIndex));
  }
  return message.instructions.some((ix) => ix.programIdIndex === programIndex && ix.accounts.includes(channelIndex));
}

async function confirmedSignature(signature: string, owner: string, channelId: string): Promise<void> {
  let landed: Awaited<ReturnType<ReturnType<typeof hireConnection>["getTransaction"]>> = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      landed = await hireConnection().getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
    } catch {
      landed = null;
    }
    if (landed) break;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  if (!landed || landed.meta?.err) fail("PAYMENT_INVALID", "The channel transaction is not on chain.", 402);
  const message = landed.transaction.message;
  const keys = accountKeysOf(message);
  if (keys[0] !== owner || !transactionMentions(message, channelId)) {
    fail("PAYMENT_INVALID", "The channel transaction does not match this job.", 402);
  }
}

export async function confirmOpenTransaction(job: Job, transaction: string, channelId: string): Promise<string> {
  let vtx: VersionedTransaction;
  try {
    vtx = VersionedTransaction.deserialize(Buffer.from(transaction, "base64"));
  } catch {
    fail("PAYMENT_INVALID", "The channel deposit could not be read.", 402);
  }
  if (!vtx.signatures[0] || Buffer.from(vtx.signatures[0]).every((byte) => byte === 0)) {
    fail("PAYMENT_INVALID", "The buyer owner has to sign the channel deposit.", 402);
  }
  const encoded = bs58.encode(vtx.signatures[0]);
  const signer = vtx.message.staticAccountKeys[0]?.toBase58();
  if (signer !== job.buyerOwner) fail("PAYMENT_INVALID", "The buyer owner has to sign this channel.", 402);
  if (!canonicalPubkey(channelId)) fail("PAYMENT_INVALID", "The payment is missing the channel.", 402);
  if (!openLocksPrice(vtx, channelId, BigInt(job.priceBaseUnits))) {
    fail("PAYMENT_INVALID", "The channel deposit does not match the locked price.", 402);
  }
  await confirmedSignature(encoded, job.buyerOwner, channelId);
  const channel = await readChannel(channelId);
  if (!channel || channel.status !== 0) fail("PAYMENT_INVALID", "The channel deposit is not on chain.", 402);
  assertMatchesJob(channel, job);
  const existing = await agentStore().listJobsForOwner(job.buyerOwner);
  if (existing.some((other) => other.id !== job.id && other.channelId === channelId && other.fundSignature)) {
    fail("PAYMENT_INVALID", "That channel is already locked to another job.", 402);
  }
  return encoded;
}

export async function confirmSettledTransaction(job: Job, signature: string, amount: bigint): Promise<void> {
  if (!canonicalPubkey(job.channelId) || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) {
    fail("PAYMENT_INVALID", "The channel transaction does not match this job.", 402);
  }
  await confirmedSignature(signature, job.buyerOwner, job.channelId);
  const channel = await readChannel(job.channelId);
  // Release pays through the permissionless settle and distribute: payment is
  // proven when the voucher amount is both settled and paid out, whatever
  // the channel status has moved to since (Open, Closing, or Distributed).
  const paidOut =
    channel != null &&
    channel.settlement.settled === amount &&
    (channel.settlement.payoutWatermark === amount || channel.status === 3);
  if (!channel || !paidOut) {
    fail("PAYMENT_INVALID", "The channel has not released this payment.", 402);
  }
  assertMatchesJob(channel, job);
}
