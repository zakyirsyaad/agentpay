import {
  Signature,
  TypedDataEncoder,
  getAddress,
  verifyTypedData,
} from "ethers";

import {
  createMainnetWalletSetupTypedData,
  mainnetWalletSetupTypedDataSchema,
  type MainnetWalletSetupPolicyContext,
  type MainnetWalletSetupTypedDataEnvelope,
} from "@agentpay-ai/shared";

const HALF_SECP256K1_ORDER = BigInt("0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0");
type EthersTypedDataTypes = Record<string, Array<{ name: string; type: string }>>;

export interface VerifyProductionSetupAuthorizationInput {
  readonly typedData: unknown;
  readonly signature: string;
  readonly expectedOwnerAddress: string;
  readonly policy: MainnetWalletSetupPolicyContext;
  readonly nowUnix: number;
  readonly getOwnerCode: (ownerAddress: string) => Promise<string>;
}

export async function verifyProductionSetupAuthorization(
  input: VerifyProductionSetupAuthorizationInput,
): Promise<Readonly<{
  ownerAddress: string;
  signature: string;
  authorizationHash: string;
  typedData: MainnetWalletSetupTypedDataEnvelope;
}>> {
  const parsed = mainnetWalletSetupTypedDataSchema.safeParse(input.typedData);
  if (!parsed.success || !Number.isSafeInteger(input.nowUnix) || input.nowUnix < 0) {
    throw new Error("SETUP_AUTHORIZATION_INVALID");
  }
  const typedData = parsed.data;
  if (BigInt(typedData.message.deadline) <= BigInt(input.nowUnix)) {
    throw new Error("SETUP_AUTHORIZATION_EXPIRED");
  }

  let expectedOwner: string;
  let canonical: ReturnType<typeof createMainnetWalletSetupTypedData>;
  try {
    expectedOwner = getAddress(input.expectedOwnerAddress).toLowerCase();
    if (typedData.message.owner.toLowerCase() !== expectedOwner) throw new Error("owner mismatch");
    canonical = createMainnetWalletSetupTypedData(typedData.message, {
      ...input.policy,
      ownerAddress: expectedOwner,
      currentUnixTime: input.nowUnix,
    });
    if (TypedDataEncoder.hash(canonical.domain, canonical.types as unknown as EthersTypedDataTypes, canonical.message) !==
      TypedDataEncoder.hash(typedData.domain, typedData.types as EthersTypedDataTypes, typedData.message)) {
      throw new Error("typed data mismatch");
    }
  } catch {
    throw new Error("SETUP_AUTHORIZATION_INVALID");
  }

  const code = await input.getOwnerCode(expectedOwner);
  if (code !== "0x") throw new Error("SETUP_OWNER_NOT_EOA");

  let normalizedSignature: string;
  let recovered: string;
  try {
    const signature = Signature.from(input.signature);
    if (
      signature.v !== 27 && signature.v !== 28 ||
      BigInt(signature.s) === 0n ||
      BigInt(signature.s) > HALF_SECP256K1_ORDER
    ) throw new Error("non-canonical signature");
    normalizedSignature = signature.serialized.toLowerCase();
    if (!/^0x[0-9a-f]{130}$/.test(normalizedSignature)) throw new Error("invalid signature length");
    recovered = verifyTypedData(
      canonical.domain,
      canonical.types as unknown as EthersTypedDataTypes,
      canonical.message,
      normalizedSignature,
    ).toLowerCase();
  } catch {
    throw new Error("SETUP_SIGNATURE_INVALID");
  }
  if (recovered !== expectedOwner) throw new Error("SETUP_SIGNATURE_INVALID");

  return Object.freeze({
    ownerAddress: expectedOwner,
    signature: normalizedSignature,
    authorizationHash: TypedDataEncoder.hash(
      canonical.domain,
      canonical.types as unknown as EthersTypedDataTypes,
      canonical.message,
    ).toLowerCase(),
    typedData,
  });
}
