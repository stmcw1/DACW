/**
 * 秘密检测与脱敏 —— B 组（写手输出不落盘）与 C 组（运行机输出脱敏）共用同一套模式，
 * 避免两处复制后分叉。
 *
 * ⚠️ 这是「已知五类」启发式检测，不是穷尽式秘密管理；用于降低泄露面，不构成保证。
 * ⚠️ 只做整文本一次性脱敏：流式逐 chunk 正则不可靠（密钥可能被 \n 或 chunk 边界切开），
 *    因此 runner.appendLog 不脱敏，finalize 对拼装完成的完整 output 统一脱敏。
 */

export interface SecretPattern {
    /** 人话类别名（写入日志/审计，不含原文）。 */
    category: string;
    /** 非全局正则（test() 无状态；脱敏时按需构造全局副本）。 */
    re: RegExp;
}

/** 五类凭据模式；顺序即匹配/替换优先级。 */
export const SECRET_PATTERNS: SecretPattern[] = [
    { category: 'PEM 私钥', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    { category: 'AWS Access Key', re: /AKIA[0-9A-Z]{16}/ },
    { category: 'GitHub Token', re: /ghp_[A-Za-z0-9]{36}/ },
    { category: 'Slack Token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
    { category: 'OpenAI Key', re: /sk-[A-Za-z0-9]{32,}/ },
];

/** 结构性输入：只关心 `changed[].{file,code}`，便于 index.ts 与回归测试直接复用。 */
export interface WriterDeltaLike {
    changed: { file: string; code: string }[];
}

/**
 * 扫描写手输出：首个命中即返回 `{ file, category }`。
 * 纯函数；只返回文件名与人类可读类别名，**不返回命中的原文**（避免二次泄露）。
 */
export function scanWriterOutputForSecrets(delta: WriterDeltaLike): { file: string; category: string } | null {
    for (const item of delta.changed) {
        for (const pattern of SECRET_PATTERNS) {
            if (pattern.re.test(item.code)) return { file: item.file, category: pattern.category };
        }
    }
    return null;
}

/**
 * 把整段文本中的凭据替换为 `[REDACTED:<类别>]`（保留结构可读性），用于测试运行机输出。
 * 返回新字符串；不修改入参。
 */
export function redactSecretsInText(text: string): string {
    if (!text) return text;
    let redacted = text;
    for (const { category, re } of SECRET_PATTERNS) {
        const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
        redacted = redacted.replace(new RegExp(re.source, flags), `[REDACTED:${category}]`);
    }
    return redacted;
}
