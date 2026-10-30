export const CHAINS: readonly string[];
export const METHODS: readonly string[];
export function idValid(value: unknown): value is string;
export function accountsValid(value: unknown): value is string[];
export function senderOrigin(sender: unknown, extensionId: string): string;
export function validateRequest(value: unknown): void;
