/**
 * Browser-side smoke scenario (2.2): create wallet -> accept a targeted
 * offer -> validate the resulting card, using the real
 * `sdk-providers-web`/`app-sdk`/`wallet-sdk`/`verifier` packages against a
 * live stack — no mocks. Bundled by `build.mjs`, loaded by `static/
 * index.html`, driven by `test/smoke.spec.ts`.
 *
 * The offer to accept is prepared and submitted (`POST /issue`) on the
 * Node side (`prepare.ts`) before this page loads — the offer itself, and
 * the on-chain "root" card that issued it, don't depend on anything
 * browser-specific. Everything from `reviewTargetedOffer` onward runs here.
 */

import { CardVerifier } from '@membership-card-protocol/verifier';
import { EthersRpcProvider } from '@membership-card-protocol/verifier-rpc-provider';
import { FilebaseIpfsProvider } from '@membership-card-protocol/verifier-ipfs-provider';
import {
  IndexedDBStorageProvider,
  WebCryptoSecureKeyProvider,
  WebAuthnPasskeyProvider,
} from '@membership-card-protocol/sdk-providers-web';
import {
  HpkeObliviousProtocolTransport,
  base64UrlToBytes,
  bytesToBase64Url,
  mlDsa44Sign,
  keccak256,
  createPressSubCardRegistrar,
  type SignedTargetedOffer,
} from '@membership-card-protocol/app-sdk';
import { setupWallet, reviewTargetedOffer, acceptTargetedOfferAndCountersign } from '@membership-card-protocol/wallet-sdk';
import { createViemRegistryContract } from './registryContract.js';
import type { HarnessConfig } from './prepare.js';

export interface ScenarioResult {
  success: boolean;
  step?: string;
  error?: string;
  cardHash?: string;
  subCardRegistered?: boolean;
  mintedCardCid?: string;
  chainReachesTrustedRoot?: boolean | 'skipped';
  isCurrentlyValid?: boolean | 'skipped';
}

export async function runScenario(config: HarnessConfig): Promise<ScenarioResult> {
  let step = 'construct-providers';
  try {
    const rpc = new EthersRpcProvider(
      createViemRegistryContract({
        rpcUrl: config.arbitrumRpcUrl,
        storageAddress: config.storageContractAddress as `0x${string}`,
      })
    );
    const ipfs = new FilebaseIpfsProvider({ gatewayUrl: `${new URL(config.pressBaseUrl).protocol}//${new URL(config.pressBaseUrl).hostname}:8080/ipfs` });
    const cardVerifier = new CardVerifier({
      rpc,
      ipfs,
      trustedRoots: [config.rootCardAddress],
      appCertificationRoot: config.rootCardAddress,
      fetchAnnotations: false,
    });

    const runId = `harness-${Date.now()}`;
    const storageProvider = new IndexedDBStorageProvider(runId);
    const secureKeyProvider = new WebCryptoSecureKeyProvider();
    const passkeyProvider = new WebAuthnPasskeyProvider({ rpId: 'localhost' });
    const transport = new HpkeObliviousProtocolTransport({
      relayBaseUrl: config.relayBaseUrl,
      walletServiceBaseUrl: config.walletServiceBaseUrl,
    });

    const rootPublicKey = base64UrlToBytes(config.rootCardPublicKeyB64);
    const rootSecretKey = base64UrlToBytes(config.rootCardSecretKeyB64);
    const walletAppCard = {
      cardPointer: config.rootCardAddress,
      publicKey: rootPublicKey,
      sign: (message: Uint8Array) => mlDsa44Sign(rootSecretKey, message),
    };
    const registerSubCard = createPressSubCardRegistrar({ transport, pressBaseUrl: config.pressBaseUrl });

    step = 'review-offer';
    const reviewResult = await reviewTargetedOffer(config.offer as unknown as SignedTargetedOffer, {
      cardVerifier,
      rpc,
      policyAddress: config.policyAddress,
      pressAddress: config.pressAddress,
    });
    if (!reviewResult.approved) {
      return { success: false, step, error: `offer rejected (${reviewResult.code}): ${reviewResult.reason}` };
    }

    step = 'setup-wallet';
    let finalizeResult: { cardCid: string; newCardPublicKeyB64: string } | undefined;
    const setupResult = await setupWallet({
      passkeyProvider,
      storageProvider,
      transport,
      secureKeyProvider,
      walletAppCard,
      registerSubCard,
      cardVerifier,
      capabilities: ['card_offer_accept'],
      notificationChannels: { email: 'harness@integration-tests.local' },
      postSetupHook: async (decryptionKey) => {
        step = 'accept-offer';
        const acceptResult = await acceptTargetedOfferAndCountersign(reviewResult, { storageProvider, decryptionKey });

        step = 'finalize-with-press';
        const finalizeRes = await fetch(`${config.pressBaseUrl}/api/issue/finalize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            offer_cid: config.offerCid,
            recipient_pubkey: bytesToBase64Url(acceptResult.newCardPublicKey),
            holder_signature: acceptResult.countersignedOffer.holder_signature,
          }),
        });
        if (!finalizeRes.ok) {
          throw new Error(`POST /issue/finalize failed: HTTP ${finalizeRes.status}: ${await finalizeRes.text()}`);
        }
        const body = (await finalizeRes.json()) as { card_cid: string };
        finalizeResult = { cardCid: body.card_cid, newCardPublicKeyB64: bytesToBase64Url(acceptResult.newCardPublicKey) };
        return finalizeResult;
      },
    });

    if (!finalizeResult) {
      return { success: false, step, error: 'postSetupHook did not run' };
    }

    step = 'validate-card';
    // Unprefixed, matching CardVerifier's own convention (compares
    // directly against `keccak256(pubkey)` — see prepare.ts's doc comment
    // on `rootAddress` for the full explanation).
    const newCardAddress = keccak256(base64UrlToBytes(finalizeResult.newCardPublicKeyB64));
    const verifyResult = await cardVerifier.verifyCard(newCardAddress, { pubkey: finalizeResult.newCardPublicKeyB64 });

    return {
      success: verifyResult.chain_reaches_trusted_root === true && verifyResult.is_currently_valid === true,
      cardHash: setupResult.cardHash,
      subCardRegistered: setupResult.subCardRegistered,
      mintedCardCid: finalizeResult.cardCid,
      chainReachesTrustedRoot: verifyResult.chain_reaches_trusted_root,
      isCurrentlyValid: verifyResult.is_currently_valid,
    };
  } catch (err) {
    return { success: false, step, error: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err) };
  }
}

declare global {
  interface Window {
    __HARNESS_CONFIG__?: HarnessConfig;
    __HARNESS_RESULT__?: ScenarioResult;
    runScenario: typeof runScenario;
  }
}

window.runScenario = runScenario;
