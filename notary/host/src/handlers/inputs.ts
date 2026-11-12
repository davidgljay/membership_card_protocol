/**
 * `POST /jobs/{job_hash}/inputs` (notary_host.md §5, §6; protocol-objects.md §24–§26), reached only through the
 * oblivious gateway. The body is a `SealedInput` the host cannot open.
 *
 * Order: size → job known and open → strict shape → store the ciphertext (a storage failure issues **no** receipt)
 * → sign the `HostReceipt` → forward to the enclave holding the job → return `{ host_receipt, receipt_sealed }`.
 * `receipt_sealed` is the enclave's encrypted validation receipt, passed through untouched.
 */
import { assertNotaryObject, canonicalNotary, H } from "@membership-card-protocol/wallet-sdk/notary-types";
import type { HostReceipt, SealedInput } from "@membership-card-protocol/wallet-sdk/notary-types";
import { HostError } from "../context.js";
import type { HostContext } from "../context.js";
import { EnclaveError } from "../enclave/transport.js";
import { signHostReceipt } from "../receipts/index.js";
import { liveSession } from "./jobs.js";

export const MAX_SEALED_INPUT = 256 * 1024;

export async function handleSubmitInput(ctx: HostContext, jobHash: string, body: unknown): Promise<{ host_receipt: HostReceipt; receipt_sealed: string }> {
  let size = 0;
  try { size = canonicalNotary(body).length; } catch { throw new HostError("INPUT_MALFORMED", "body is not canonical-serializable JSON"); }
  if (size > MAX_SEALED_INPUT) throw new HostError("NH_INPUT_TOO_LARGE", "SealedInput is larger than 256 KiB", 413);
  const job = await ctx.jobs.get(jobHash);
  if (!job) throw new HostError("NH_JOB_UNKNOWN", "no such job on this host", 404);
  if (job.state === "finalized" || job.state === "ended" || job.state === "aborted") throw new HostError("NH_JOB_CLOSED", "the job is finalized or ended", 410);
  try { assertNotaryObject(body, "notary.sealed_input.v1"); } catch (e) { throw new HostError("INPUT_MALFORMED", (e as Error).message); }
  const sealed = body as unknown as SealedInput;
  if (sealed.job_hash !== jobHash) throw new HostError("INPUT_WRONG_JOB", "sealed input is for another job");
  const inputHash = H(sealed);
  const receivedAt = new Date(ctx.now()).toISOString();
  // 1. store the ciphertext; if it cannot be stored, no receipt is issued
  try { await ctx.inputs.put(jobHash, sealed.epoch, inputHash, { sealedInput: sealed, receivedAt }); }
  catch { await ctx.monitor.alert("error", "storage_failure"); throw new HostError("NH_STORAGE_FAILED", "the ciphertext could not be stored; no receipt issued", 503); }
  // 2. the host receipt: proof the operator received the ciphertext
  const notaryCard = ctx.config.NOTARY_CARD_ADDRESSES.find((c) => (job.job as { replica_set: { notary_card: string }[] }).replica_set.some((r) => r.notary_card === c)) ?? ctx.config.NOTARY_CARD_ADDRESSES[0]!;
  const host_receipt = signHostReceipt(ctx.keys, { epoch: sealed.epoch, input_hash: inputHash, job_hash: jobHash, notary_card: notaryCard, received_at: receivedAt, type: "notary.host_receipt.v1" });
  await ctx.receipts.put(inputHash, host_receipt);
  // 3. forward to the enclave holding the job
  const session = liveSession(ctx, job.replicas);
  let reply;
  try { reply = await session.call("submit_input", { job_hash: jobHash, sealed_input: sealed }); }
  catch (e) {
    if (e instanceof EnclaveError) {
      // an input the enclave cannot decrypt cannot be counted: do not keep it, and no receipt is returned
      if (e.code === "INPUT_UNDECRYPTABLE") { await ctx.inputs.remove(jobHash, sealed.epoch, inputHash); }
      throw new HostError(e.code, e.message, e.code === "NH_ENCLAVE_UNAVAILABLE" ? 503 : 422);
    }
    throw e;
  }
  return { host_receipt, receipt_sealed: String(reply["receipt_sealed"]) };
}
