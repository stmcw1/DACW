import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

// 单实例假设：writeChain 仅提供进程内互斥。多进程/多会话对同一 taskId 并发
// 写入时为 last-writer-wins，checksum/HMAC 无法检测丢失更新。
// 当前部署形态（DSH 插件内单协调器 + workspaceLocks 串行化）满足该假设；
// 若未来多进程并发，需引入文件锁（O_EXCL 锁文件或等价物），属架构层变更。

export type WorkflowStatus = 'IDLE' | 'RUNNING' | 'NEED_HUMAN' | 'DONE';


export interface WorkflowState {
    taskId: string;
    round: number;
    status: WorkflowStatus;
    taskPrompt: string;
    writtenFiles: string | null;   
    testResult: string | null;     
    reviewResult: string | null;
    /** 本轮审查阶段因敏感被排除、未送模型审查的文件清单（审计可追溯）；null 表示无排除。 */
    reviewExcluded: string[] | null;
    lastError: string | null;      
}

interface PersistedState {
    version: 1;                    
    taskId: string;
    round: number;
    status: WorkflowStatus;
    taskPrompt: string;
    writtenFiles: string | null;
    testResult: string | null;
    reviewResult: string | null;
    reviewExcluded: string[] | null;
    lastError: string | null;
    checksum: string;
}

export class StateManager {
    private stateDir: string;
    private stateFilePath: string;
    private taskId: string;
    private readonly macSecret: string | Buffer | null;

    private writeChain: Promise<unknown> = Promise.resolve();
    private authoritative: WorkflowState | null = null;
    private tmpSeq = 0;

    /**
     * macSecret：提供时使用 HMAC-SHA256 校验。
     * 运行机里执行的写手代码与协调器同用户同权限，可写 os.tmpdir()；
     * 无密钥 SHA256 只能防意外损坏，防不了"篡改后重算 checksum"——
     * 不提供密钥时只能声称防损坏，不得声称防篡改。
     * 密钥仅存在于协调器内存，且不会经运行机的 env 白名单透传。
     * 注意：密钥为每次运行随机生成时，跨进程/跨重启的 load() 将无法通过校验；
     * 当前协调器按单次运行使用状态文件（见协调器 [P2-1] 注释），不受影响。
     *
     * rawTaskId 先消毒、再附加其 SHA256 短哈希作为文件名后缀：
     * "task/1" 与 "task_1" 消毒后同为 "task_1"，哈希后缀消除该碰撞。
     */
    constructor(stateDir: string, rawTaskId: string, workspaceDir: string, macSecret?: string | Buffer) {
        const safeTaskId = rawTaskId.replace(/[^a-zA-Z0-9_\-]/g, '_');
        // 哈希输入纳入 workspaceDir：不同工作区的同名任务（"task-1"）不再互相覆盖
        // 状态文件，"各自 HMAC 均合法的静默交叉覆盖"被根除
        const idHash = crypto.createHash('sha256')
            .update(String(rawTaskId) + '\n' + String(workspaceDir))
            .digest('hex').slice(0, 8);
        this.taskId = safeTaskId;
        this.macSecret = macSecret ?? null;
        this.stateDir = path.resolve(stateDir);
        this.stateFilePath = path.join(this.stateDir, `state_${safeTaskId}_${idHash}.json`);
    }

    private macOf(body: string): string {
        if (this.macSecret !== null) {
            return crypto.createHmac('sha256', this.macSecret).update(body).digest('hex');
        }
        return crypto.createHash('sha256').update(body).digest('hex');
    }

    private checksumOf(state: WorkflowState): string {
        const { taskId, round, status, taskPrompt, writtenFiles, testResult, reviewResult, reviewExcluded, lastError } = state;
        const body = JSON.stringify({
            taskId, round, status, taskPrompt, writtenFiles, testResult, reviewResult,
            reviewExcluded: reviewExcluded ?? null, lastError,
        });
        return this.macOf(body);
    }

    private async persist(state: WorkflowState): Promise<void> {
        await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
        const payload: PersistedState = { version: 1, ...state, checksum: this.checksumOf(state) };
        const tmpPath = `${this.stateFilePath}.${process.pid}.${Date.now()}.${this.tmpSeq++}.tmp`;
        const fh = await fs.open(tmpPath, 'w', 0o600);
        try {
            await fh.writeFile(JSON.stringify(payload, null, 2), 'utf8');
            await fh.sync();
        } finally {
            await fh.close();
        }
        // Windows 下目标可能被杀软/索引器短暂占用导致 rename EPERM，小步退避重试
        let renameErr: unknown = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await fs.rename(tmpPath, this.stateFilePath);
                renameErr = null;
                break;
            } catch (e: any) {
                renameErr = e;
                if (e?.code !== 'EPERM' && e?.code !== 'EACCES') break;
                await new Promise(r => setTimeout(r, 50 * (attempt + 1)));
            }
        }
        if (renameErr !== null) {
            // 失败路径清理 tmp 文件，防泄漏
            await fs.unlink(tmpPath).catch(() => { });
            throw renameErr;
        }
        try {
            // POSIX：目录 fsync 保证 rename 落盘；Windows 不支持目录句柄 fsync，
            // 此处必然失败属预期行为，静默跳过（持久性已由文件 fsync + rename 语义保证）
            const dh = await fs.open(this.stateDir, 'r');
            try { await dh.sync(); } finally { await dh.close(); }
        } catch { }
    }

    private async readFromDisk(): Promise<WorkflowState> {
        const raw = await fs.readFile(this.stateFilePath, 'utf8');
        const parsed = JSON.parse(raw) as PersistedState;
        if (parsed.version !== 1) {
            throw new Error(`[状态管理器] 状态文件格式版本不匹配：期望 1，收到 ${String((parsed as any).version)}`);
        }
        const { checksum, version, ...state } = parsed;
        void version;
        if (typeof checksum !== 'string' || checksum !== this.checksumOf(state as WorkflowState)) {
            throw new Error('[状态管理器] 状态文件校验失败（被外部篡改或密钥不匹配）');
        }
        return state as WorkflowState;
    }

    private enqueue<T>(job: () => Promise<T>): Promise<T> {
        const next = this.writeChain.then(job, job);
        this.writeChain = next.then(() => undefined, () => undefined);
        return next;
    }

    public async init(taskPrompt: string): Promise<WorkflowState> {
        return this.enqueue(async () => {
            const initial: WorkflowState = {
                taskId: this.taskId, round: 1, status: 'RUNNING', taskPrompt,
                writtenFiles: null, testResult: null, reviewResult: null,
                reviewExcluded: null, lastError: null
            };
            await this.persist(initial);
            this.authoritative = initial;
            return initial;
        });
    }

    /**
     * 语义严格化：
     * - ENOENT（文件不存在）→ 新任务，返回 null；
     * - 校验失败 / 版本不匹配 / 其他 IO 错误 → 一律抛出（fail-closed），
     *   绝不把"被篡改"伪装成"没有历史"。
     */
    public async load(): Promise<WorkflowState | null> {
        if (this.authoritative) return this.authoritative;
        return this.enqueue(async () => {
            if (this.authoritative) return this.authoritative;
            try {
                const s = await this.readFromDisk();
                this.authoritative = s;
                return s;
            } catch (e: any) {
                if (e?.code === 'ENOENT') return null;
                throw e;
            }
        });
    }

    public async update(mutator: (state: WorkflowState) => void | Promise<void>): Promise<WorkflowState> {
        return this.enqueue(async () => {
            if (!this.authoritative) {
                throw new Error('[状态管理器] 状态未初始化，禁止 update（应先 init 或 load 恢复）');
            }
            const draft: WorkflowState = { ...this.authoritative };
            await mutator(draft);
            if (draft.round < this.authoritative.round) {
                throw new Error(`[状态管理器] 拒绝过期写入：round ${draft.round} < 当前 ${this.authoritative.round}`);
            }
            await this.persist(draft);
            this.authoritative = draft;
            return draft;
        });
    }
}
