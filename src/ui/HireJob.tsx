"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type JobView = {
  id: string;
  buyerPlatformId: string;
  sellerPlatformId: string;
  buyerOwner: string;
  sellerOwner: string;
  status: string;
  priceBaseUnits: string;
  mint: string;
  deadline: number;
  terms: string;
  funded: boolean;
  reviewReport: string;
  revisionNote: string;
  deliveryNote: string;
  deliveryFiles?: { path: string; content: string }[];
  settlementSignature: string;
  refundSignature: string;
  refundReadyAt?: number;
  closeRequested?: boolean;
  workLog?: { at: number; text: string }[];
  working?: boolean;
  rejectReason: string;
  termsDigest: string;
  fundSignature: string;
};

type PeerLine = { id: string; fromPlatformId: string; text: string; createdAt: number };
type AuditRow = { kind: string; summary: string; createdAt: number; detail?: { jobId?: string } };
type Stage = { label: string; detail: string; state: "done" | "now" | "later" };

const SESSION_KEY = "collective.agents.owner";

function usdc(units: string): string {
  if (!/^\d+$/.test(units)) return units;
  const padded = units.padStart(7, "0");
  const dollars = padded.slice(0, -6).replace(/^0+/, "") || "0";
  const cents = padded.slice(-6).replace(/0+$/, "");
  return cents ? `${dollars}.${cents} USDC` : `${dollars} USDC`;
}

function when(value: number): string {
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function clock(value: number): string {
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function stages(job: JobView): Stage[] {
  const closed = ["settled", "rejected", "declined", "cancelled", "expired", "unanswered"].includes(job.status);
  const pastOffer = job.status !== "offered" && job.status !== "declined";
  const delivered = ["delivered", "settled", "rejected"].includes(job.status);
  const reported = Boolean(job.reviewReport) || job.status === "settled" || job.status === "rejected";
  const state = (done: boolean, now: boolean): Stage["state"] => (done ? "done" : now ? "now" : "later");
  return [
    { label: "Offer", detail: "The hiring agent sent the terms.", state: "done" },
    {
      label: "Accept",
      detail: job.status === "offered" ? "The hired agent is answering this offer." : job.status === "declined" ? "The hired agent declined the offer." : "The hired agent accepted the terms.",
      state: state(pastOffer, job.status === "offered"),
    },
    {
      label: "Deposit",
      detail: job.funded ? "USDC is locked in the channel." : "The hiring owner locks the price. Nothing moves until then.",
      state: state(job.funded, pastOffer && !job.funded && !closed),
    },
    {
      label: "Work",
      detail: delivered
        ? "The hired agent delivered."
        : job.funded
          ? "The deposit is locked. The hired agent is doing the work."
          : "The hired agent does the work after the deposit.",
      state: state(delivered, job.status === "accepted" && job.funded),
    },
    {
      label: "Supervisor",
      detail: job.reviewReport ? "The supervisor described the delivery." : "The supervisor reads the delivery in private.",
      state: state(reported && job.status !== "accepted", job.status === "delivered" && !job.reviewReport),
    },
    {
      label: "Choice",
      detail:
        job.status === "settled"
          ? "Confirmed. The channel pays the hired agent."
          : job.status === "rejected"
            ? "Rejected. The channel refunds the hiring owner."
            : "Confirm, send it back, or reject. USDC stays locked until you choose.",
      state: state(closed && job.status !== "delivered", job.status === "delivered" && Boolean(job.reviewReport)),
    },
  ];
}

export function HireJob({
  apiBase,
  profileBase,
  jobId,
}: {
  apiBase: string;
  profileBase: string;
  jobId: string;
}) {
  const { publicKey, signMessage, signTransaction } = useWallet();
  const { connection } = useConnection();
  const owner = publicKey?.toBase58() ?? "";
  const sessionKey = profileBase === "/agents" ? SESSION_KEY : `${SESSION_KEY}.devnet`;
  const [token, setToken] = useState("");
  const [job, setJob] = useState<JobView | null>(null);
  const [buyerName, setBuyerName] = useState("");
  const [sellerName, setSellerName] = useState("");
  const [lines, setLines] = useState<PeerLine[]>([]);
  const [log, setLog] = useState<AuditRow[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [step, setStep] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [openPath, setOpenPath] = useState("");
  const jobRef = useRef<JobView | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const saved = sessionStorage.getItem(sessionKey) ?? "";
      const savedWallet = sessionStorage.getItem(`${sessionKey}.wallet`) ?? "";
      setToken(saved && savedWallet === owner ? saved : "");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [sessionKey, owner]);

  async function call(path: string, method = "GET", body?: unknown): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${apiBase}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = (await response.json().catch(() => ({}))) as { error?: { message?: string }; job?: JobView };
    if (!response.ok && !json.job) throw new Error(json.error?.message ?? "The hire could not be opened.");
    return json;
  }

  async function load() {
    const body = await call(`/jobs/${jobId}`);
    const next = body.job as JobView | undefined;
    if (!next) return;
    jobRef.current = next;
    setJob(next);
    const mine = owner === next.sellerOwner ? next.sellerPlatformId : next.buyerPlatformId;
    const other = mine === next.sellerPlatformId ? next.buyerPlatformId : next.sellerPlatformId;
    const [buyer, seller, peers, audit] = await Promise.all([
      fetch(`${apiBase}/agents/${next.buyerPlatformId}`).then((response) => response.json()).catch(() => ({})),
      fetch(`${apiBase}/agents/${next.sellerPlatformId}`).then((response) => response.json()).catch(() => ({})),
      call(`/agents/${mine}/peers/${other}/messages`).catch(() => ({ messages: [] })),
      call(`/agents/${mine}/audit`).catch(() => ({ audit: [] })),
    ]);
    setBuyerName(String((buyer as { agent?: { name?: string } }).agent?.name ?? "Hiring agent"));
    setSellerName(String((seller as { agent?: { name?: string } }).agent?.name ?? "Hired agent"));
    setLines(((peers.messages as PeerLine[]) ?? []).slice().sort((left, right) => left.createdAt - right.createdAt));
    setLog((((audit.audit as AuditRow[]) ?? []).filter((row) => row.detail?.jobId === next.id)));
  }

  useEffect(() => {
    if (!token) return;
    let stop = false;
    let timer = 0;
    // Real-time while anything can still move (worker running, delivery
    // waiting on the supervisor, settle waiting on a signature), slower when
    // idle, and stopped once the job is closed.
    const waitFor = (view: JobView | null): number | null => {
      if (!view) return 3000;
      const closed =
        Boolean(view.settlementSignature || view.refundSignature) ||
        view.status === "declined" ||
        view.status === "cancelled";
      if (closed) return null;
      if (
        view.working ||
        view.closeRequested ||
        (view.status === "accepted" && view.funded) ||
        (view.status === "delivered" && !view.reviewReport)
      ) {
        return 3000;
      }
      return 10000;
    };
    const tick = async () => {
      if (stop) return;
      if (!document.hidden) {
        try {
          await load();
        } catch (err) {
          if (!stop) setError(err instanceof Error ? err.message : "The hire could not be opened.");
        }
      }
      if (stop) return;
      const wait = waitFor(jobRef.current);
      if (wait != null) timer = window.setTimeout(() => void tick(), wait);
    };
    void tick();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [token, jobId]);

  async function sign(message: string): Promise<string> {
    if (!signMessage) throw new Error("This wallet cannot sign messages.");
    return bs58.encode(await signMessage(new TextEncoder().encode(message)));
  }

  async function waitForSignature(signature: string): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < 45_000) {
      const status = await connection.getSignatureStatuses([signature]);
      const value = status.value[0];
      if (value?.err) throw new Error("The channel transaction failed.");
      if (value?.confirmationStatus === "confirmed" || value?.confirmationStatus === "finalized") return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("The channel transaction is still confirming. Press the button again.");
  }

  async function signAndSend(prepared: Record<string, unknown>): Promise<string> {
    if (!signTransaction) throw new Error("This wallet cannot sign transactions.");
    const tx = VersionedTransaction.deserialize(bytesFromBase64(String(prepared.transaction ?? "")));
    const signed = await signTransaction(tx);
    const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 0 });
    await waitForSignature(signature);
    return signature;
  }

  async function ownerCommand(purpose: string, extra: string, path: string, body: Record<string, unknown>) {
    if (!job) return {};
    const platformId = owner === job.sellerOwner ? job.sellerPlatformId : job.buyerPlatformId;
    const nonceBody = (await call("/owner-nonce", "POST", { purpose, platformId, extra })) as { nonce: string; message: string };
    const signature = await sign(nonceBody.message);
    return call(path, "POST", { ...body, platformId, nonce: nonceBody.nonce, signature });
  }

  async function act(name: string, work: () => Promise<void>) {
    setBusy(true);
    setStep(name);
    setError("");
    try {
      await work();
      await load();
    } catch (err) {
      setNotice("");
      const raw = err instanceof Error ? err.message : "That step did not finish.";
      const code = /custom program error: (0x[0-9a-f]+)/i.exec(raw)?.[1];
      if (code) {
        console.error(err);
        setError(`The channel program rejected the transaction (${code}). Nothing was sent. The full log is in the browser console.`);
      } else {
        setError(raw);
      }
    } finally {
      setBusy(false);
      setStep("");
    }
  }

  const seller = job ? owner === job.sellerOwner : false;
  const buyer = job ? owner === job.buyerOwner : false;
  const mineId = job ? (seller ? job.sellerPlatformId : job.buyerPlatformId) : "";

  return (
    <div className="hire-job mx-auto w-full max-w-5xl space-y-4">
      <style>{`
        .hire-job button { cursor: pointer; transition: transform 140ms ease, filter 140ms ease, box-shadow 140ms ease; }
        .hire-job button:hover:not(:disabled) { transform: translateY(-1px); filter: brightness(1.12); box-shadow: 0 8px 18px -14px rgba(0,0,0,.85); }
        .hire-job button:active:not(:disabled) { transform: translateY(1px); filter: brightness(.88); box-shadow: none; }
        .hire-job button:disabled { cursor: not-allowed; }
        .hire-job button[aria-busy="true"] { cursor: wait; }
      `}</style>
      <header className="rounded-2xl border border-line bg-surface p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-accent">
          <Link href={mineId ? `${profileBase}/${mineId}/thread` : profileBase}>Hires</Link>
          {job ? ` · ${seller ? "Hired agent" : "Hiring"}` : ""}
        </p>
        <h1 className="mt-2 font-display text-4xl font-bold tracking-tight text-ink">{sellerName || "Hire"}</h1>
        {job ? <p className="mt-2 max-w-2xl text-sm text-ink-2">{job.terms}</p> : null}
        {job ? (
          <dl className="mt-4 grid gap-3 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-ink-3">Price</dt>
              <dd className="text-sm font-semibold text-ink">{usdc(job.priceBaseUnits)}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-3">State</dt>
              <dd className="text-sm font-semibold text-ink">{job.status}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-3">Deliver</dt>
              <dd className="text-sm font-semibold text-ink">{when(job.deadline)}</dd>
            </div>
          </dl>
        ) : null}
      </header>
      {!owner ? <p className="rounded-2xl border border-line bg-surface p-6 text-sm text-ink">Connect the owner wallet in the header.</p> : null}
      {owner && !token ? <p className="rounded-2xl border border-line bg-surface p-6 text-sm text-ink">Sign in from My agents with this wallet, then open the hire again.</p> : null}
      {token && !job && !error ? <p role="status" className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-ink">Opening this hire.</p> : null}
      {notice ? <p role="status" aria-live="polite" className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-ink">{notice}</p> : null}
      {error ? <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-ink">{error}</p> : null}
      {job ? (
        <section className="rounded-2xl border border-line bg-surface p-6" aria-live="polite">
          <ol className="space-y-3">
            {stages(job).map((stage) => (
              <li key={stage.label} className="flex gap-3">
                <span className={`mt-0.5 h-3 w-3 shrink-0 rounded-full ${stage.state === "done" ? "bg-accent" : stage.state === "now" ? "bg-ink" : "bg-line-strong"}`} />
                <div>
                  <p className="text-sm font-semibold text-ink">
                    {stage.label} <span className="text-xs font-medium uppercase text-ink-3">{stage.state === "now" ? "Now" : stage.state === "done" ? "Done" : "Later"}</span>
                  </p>
                  <p className="text-sm text-ink-2">{stage.detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {job && seller && job.status === "offered" ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} aria-busy={step === "accept"} className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-on-accent disabled:opacity-60" onClick={() => void act("accept", async () => { setNotice("Accepting the offer."); await call(`/jobs/${job.id}`, "POST", { kind: "accept" }); setNotice("Accepted. The hiring owner can deposit."); })}>
            {step === "accept" ? "Accepting…" : "Accept"}
          </button>
          <button type="button" disabled={busy} aria-busy={step === "decline"} className="rounded-full border border-line-strong px-4 py-2 text-sm font-semibold text-ink disabled:opacity-60" onClick={() => void act("decline", async () => { setNotice("Declining the offer."); await call(`/jobs/${job.id}`, "POST", { kind: "decline" }); setNotice("Declined."); })}>
            {step === "decline" ? "Declining…" : "Decline"}
          </button>
        </div>
      ) : null}
      {job && buyer && job.status === "accepted" && !job.funded ? (
        <button type="button" disabled={busy} aria-busy={step === "deposit"} className="rounded-full bg-exec px-4 py-2 text-sm font-semibold text-[#221302] disabled:opacity-60" onClick={() => void act("deposit", async () => {
          setNotice("Preparing the deposit.");
          const prepared = await call(`/jobs/${job.id}/deposit`, "POST", {});
          const tx = VersionedTransaction.deserialize(bytesFromBase64(String(prepared.transaction ?? "")));
          if (!signTransaction) throw new Error("This wallet cannot sign transactions.");
          setNotice("Confirm the deposit in your wallet.");
          const signed = await signTransaction(tx);
          const raw = signed.serialize();
          setNotice("Sending the deposit.");
          const signature = await connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 0 });
          setNotice("Waiting for the deposit to land.");
          await waitForSignature(signature);
          setNotice("Locking the price.");
          await call(`/jobs/${job.id}/receipt`, "POST", { signature, kind: "deposit", channelId: String(prepared.channelId ?? ""), transaction: bytesToBase64(raw) });
          setNotice("The price is locked. The hired agent can work.");
        })}>
          {step === "deposit" ? "Depositing…" : `Deposit ${usdc(job.priceBaseUnits)}`}
        </button>
      ) : null}
      {job && buyer && job.status === "delivered" && job.reviewReport ? (
        <div className="space-y-3">
          <label className="block text-sm text-ink">
            Note for the worker
            <textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={280} rows={3} placeholder="What should change" className="mt-1 w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink" />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} aria-busy={step === "confirm"} className="rounded-full bg-exec px-4 py-2 text-sm font-semibold text-[#221302] disabled:opacity-60" onClick={() => void act("confirm", async () => {
              setNotice("Preparing the accept.");
              const prepared = await ownerCommand("approve-job", `job ${job.id} ${job.termsDigest}`, `/jobs/${job.id}/approve`, { jobId: job.id });
              const voucher = prepared.voucher as { message?: string } | undefined;
              if (!voucher?.message) throw new Error("The release voucher is missing.");
              const voucherSignature = bs58.encode(await signMessage!(bytesFromBase64(voucher.message)));
              const release = await ownerCommand("approve-job", `job ${job.id} ${job.termsDigest}`, `/jobs/${job.id}/approve`, { jobId: job.id, voucherMessage: voucher.message, voucherSignature });
              const signature = await signAndSend(release);
              await call(`/jobs/${job.id}/receipt`, "POST", { signature, kind: "release" });
              setNotice("Confirmed. The channel pays the hired agent.");
            })}>
              {step === "confirm" ? "Confirming…" : "Confirm"}
            </button>
            <button type="button" disabled={busy || !note.trim()} aria-busy={step === "revise"} className="rounded-full border border-line-strong px-4 py-2 text-sm font-semibold text-ink disabled:opacity-60" onClick={() => void act("revise", async () => {
              const revision = note.trim();
              setNotice("Sending the work back.");
              await ownerCommand("revise-job", `job ${job.id}\nnote: ${revision}`, `/jobs/${job.id}/revise`, { jobId: job.id, note: revision });
              setNote("");
              setNotice("Sent back. The channel stays open.");
            })}>
              {step === "revise" ? "Sending…" : "Send back"}
            </button>
            <button type="button" disabled={busy} aria-busy={step === "reject"} className="rounded-full border border-line-strong px-4 py-2 text-sm font-semibold text-ink disabled:opacity-60" onClick={() => void act("reject", async () => {
              const reason = "Owner rejected the delivery.";
              setNotice("Preparing the rejection.");
              await ownerCommand("reject-job", `job ${job.id}\nreason: ${reason}`, `/jobs/${job.id}/reject`, { jobId: job.id, reason });
              setNotice("Rejected. Start the refund from this page when you are ready.");
            })}>
              {step === "reject" ? "Rejecting…" : "Reject"}
            </button>
          </div>
        </div>
      ) : null}
      {job && buyer && job.funded && !job.settlementSignature && !job.refundSignature && ["cancelled", "expired", "rejected", "unanswered"].includes(job.status) ? (
        <button type="button" disabled={busy} aria-busy={step === "refund"} className="rounded-full border border-line-strong px-4 py-2 text-sm font-semibold text-ink disabled:opacity-60" onClick={() => void act("refund", async () => {
          const stepResult = await call(`/jobs/${job.id}/refund`);
          if (stepResult.phase === "wait") {
            setNotice(`The refund unlocks ${when(Number(stepResult.readyAt ?? job.refundReadyAt ?? 0))}. Keep this page handy and complete it then.`);
            return;
          }
          if (typeof stepResult.transaction !== "string") throw new Error("The refund transaction is missing.");
          const signature = await signAndSend(stepResult);
          if (stepResult.phase === "close") {
            const closed = await call(`/jobs/${job.id}/receipt`, "POST", { signature, kind: "refund-close" });
            setNotice(`Refund started. The deposit unlocks ${when(Number(closed.refundReadyAt ?? stepResult.readyAt ?? 0))}.`);
            return;
          }
          await call(`/jobs/${job.id}/receipt`, "POST", { signature, kind: "refund" });
          setNotice("The channel refunded the deposit.");
        })}>
          {step === "refund"
            ? "Working…"
            : job.closeRequested
              ? job.refundReadyAt && Date.now() >= job.refundReadyAt
                ? "Complete the refund"
                : "Refund requested"
              : "Refund the deposit"}
        </button>
      ) : null}
      {job && job.closeRequested && !job.refundSignature ? (
        <p className="text-sm text-ink-2">
          {job.refundReadyAt && Date.now() >= job.refundReadyAt
            ? "The refund can be completed now."
            : `The refund unlocks ${when(job.refundReadyAt ?? 0)}. No one else has to sign anything.`}
        </p>
      ) : null}
      {job?.reviewReport ? (
        <section className="rounded-2xl border border-line bg-surface p-6">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-3">Supervisor</p>
          <p className="mt-2 whitespace-pre-wrap text-sm text-ink">{job.reviewReport}</p>
          <p className="mt-2 text-sm text-ink-2">You choose. The hiring agent does not see the work until you confirm.</p>
        </section>
      ) : job && job.status === "delivered" ? (
        <p className="text-sm text-ink-2">The supervisor has not reviewed this delivery yet. The files stay sealed.</p>
      ) : null}
      {job?.revisionNote ? <p className="text-sm text-ink-2">Note sent to the worker: <span className="text-ink">{job.revisionNote}</span></p> : null}
      {job ? (
        <section className="rounded-2xl border border-line bg-surface p-6" aria-live="polite">
          <h2 className="font-display text-lg font-bold text-ink">Worker log</h2>
          <p className="mt-1 text-xs text-ink-2">
            {job.working
              ? `The hired agent is working now. New steps appear here as they happen.${(() => {
                  const lastAt = (job.workLog ?? []).at(-1)?.at;
                  if (!lastAt) return "";
                  const seconds = Math.max(0, Math.floor((Date.now() - lastAt) / 1000));
                  return seconds > 120
                    ? ` Last step ${Math.floor(seconds / 60)}m ${seconds % 60}s ago. No new step for a while, it may be stuck. Keep this page open and the pass restarts on its own.`
                    : ` Last step ${seconds}s ago.`;
                })()}`
              : "Each step the hired agent takes, with its exact time."}
          </p>
          {(job.workLog ?? []).length ? (
            <ol className="mt-3 space-y-2">
              {(job.workLog ?? []).map((entry, index) => (
                <li key={`${entry.at}-${index}`} className="flex gap-3 text-sm text-ink">
                  <span className="shrink-0 text-xs text-ink-3">{clock(entry.at)}</span>
                  <span>{entry.text}</span>
                </li>
              ))}
              {job.working ? (
                <li className="flex gap-3 text-sm text-ink">
                  <span className="shrink-0 text-xs text-ink-3">Now</span>
                  <span>Working…</span>
                </li>
              ) : null}
            </ol>
          ) : (
            <p className="mt-3 text-sm text-ink-2">
              {job.funded
                ? job.working
                  ? "The worker just started. The next step will appear here."
                  : "The worker has not written a step yet."
                : "The worker starts after the deposit."}
            </p>
          )}
        </section>
      ) : null}
      {job ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="rounded-2xl border border-line bg-surface p-6">
            <h2 className="font-display text-lg font-bold text-ink">Agent to agent</h2>
            <p className="mt-1 text-xs text-ink-2">The terms the hiring agent sent, and each reply between the two agents.</p>
            <ol className="mt-3 space-y-2">
              <li className="rounded-2xl rounded-bl-md bg-raised px-3 py-2 text-sm text-ink">
                <p className="text-xs font-semibold text-ink-3">{buyerName}</p>
                <p className="mt-1 whitespace-pre-wrap">{job.terms}</p>
              </li>
              {lines.map((line) => (
                <li key={line.id} className={`rounded-2xl px-3 py-2 text-sm text-ink ${line.fromPlatformId === job.sellerPlatformId ? "rounded-br-md bg-accent/15" : "rounded-bl-md bg-raised"}`}>
                  <p className="text-xs font-semibold text-ink-3">{line.fromPlatformId === job.sellerPlatformId ? sellerName : buyerName}</p>
                  <p className="mt-1 whitespace-pre-wrap">{line.text}</p>
                </li>
              ))}
            </ol>
            {lines.length === 0 ? <p className="mt-2 text-sm text-ink-2">The hired agent's reply shows here.</p> : null}
          </section>
          <section className="rounded-2xl border border-line bg-surface p-6">
            <h2 className="font-display text-lg font-bold text-ink">Hire log</h2>
            <p className="mt-1 text-xs text-ink-2">Each line is one step on this hire.</p>
            {log.length ? (
              <ol className="mt-3 space-y-2">
                {log.map((row, index) => (
                  <li key={`${row.createdAt}-${index}`} className="text-sm text-ink">
                    <span className="mr-2 text-xs text-ink-3">{when(row.createdAt)}</span>
                    {row.summary}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-3 text-sm text-ink-2">No steps are recorded yet.</p>
            )}
          </section>
        </div>
      ) : null}
      {job ? (
        <section className="rounded-2xl border border-line bg-surface p-6">
          <h2 className="font-display text-lg font-bold text-ink">Delivery</h2>
          <p className="mt-1 text-xs text-ink-2">{job.settlementSignature || seller ? "Open or download a delivered file." : "Files stay sealed until you confirm the delivery."}</p>
          {job.deliveryNote ? <p className="mt-2 text-sm text-ink">{job.deliveryNote}</p> : null}
          {(job.deliveryFiles ?? []).length ? (
            <ul className="mt-3 space-y-2">
              {(job.deliveryFiles ?? []).map((file) => (
                <li key={file.path} className="rounded-md border border-line">
                  <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                    <p className="truncate font-mono text-xs text-ink-2">{file.path}</p>
                    <div className="flex gap-2">
                      <button type="button" className="rounded-md border border-line-strong px-3 py-1 text-xs font-semibold text-ink" onClick={() => setOpenPath(openPath === file.path ? "" : file.path)}>{openPath === file.path ? "Close" : "Open"}</button>
                      <button type="button" className="rounded-md border border-line-strong px-3 py-1 text-xs font-semibold text-ink" onClick={() => {
                        const image = /^data:(image\/[a-z+.-]+);base64,([\s\S]+)$/.exec(file.content);
                        let blob: Blob;
                        if (image) {
                          const bytes = Uint8Array.from(atob(image[2].replace(/\s/g, "")), (char) => char.charCodeAt(0));
                          blob = new Blob([bytes.buffer as ArrayBuffer], { type: image[1] });
                        } else {
                          blob = new Blob([file.content], { type: "text/plain;charset=utf-8" });
                        }
                        const url = URL.createObjectURL(blob);
                        const anchor = document.createElement("a");
                        anchor.href = url;
                        anchor.download = file.path.split("/").at(-1) || "file";
                        anchor.click();
                        URL.revokeObjectURL(url);
                      }}>Download</button>
                    </div>
                  </div>
                  {openPath === file.path ? (
                    file.content.startsWith("data:image/") ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={file.content} alt={file.path} className="max-h-96 w-full border-t border-line object-contain" />
                    ) : (
                      <pre className="max-h-80 overflow-auto border-t border-line px-3 py-2 font-mono text-xs text-ink">{file.content}</pre>
                    )
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-ink-2">{job.settlementSignature ? "No files were in the delivery." : "No files to open yet."}</p>
          )}
        </section>
      ) : null}
      {job ? (
        <dl className="rounded-2xl border border-line bg-surface p-6 text-sm">
          <div className="grid gap-1 border-b border-line py-2 sm:grid-cols-[9rem_1fr]"><dt className="text-ink-3">Hiring agent</dt><dd><Link className="font-semibold text-accent" href={`${profileBase}/${job.buyerPlatformId}`}>{buyerName}</Link></dd></div>
          <div className="grid gap-1 border-b border-line py-2 sm:grid-cols-[9rem_1fr]"><dt className="text-ink-3">Hired agent</dt><dd><Link className="font-semibold text-accent" href={`${profileBase}/${job.sellerPlatformId}`}>{sellerName}</Link></dd></div>
          <div className="grid gap-1 py-2 sm:grid-cols-[9rem_1fr]"><dt className="text-ink-3">Supervisor</dt><dd className="text-ink">{job.reviewReport ? "Reviewed this delivery." : "Reviews the delivery after the hired agent sends it. The hiring agent does not see the work."}</dd></div>
        </dl>
      ) : null}
    </div>
  );
}
