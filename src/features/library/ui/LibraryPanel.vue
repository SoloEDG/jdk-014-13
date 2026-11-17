<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  Upload,
  BookOpen,
  Pause,
  Play,
  Check,
  AlertTriangle,
  Download,
  RotateCcw,
  ChevronUp,
  ChevronDown,
  Loader2,
} from "lucide-vue-next";
import {
  estimateBytes,
  formatBytes,
  summarize,
  type ImportTask,
  type ImportMode,
} from "../lib/importTask";

const props = defineProps<{
  busy: boolean;
  message: string;
  task: ImportTask | null;
  fileRequest: number;
  quotaBytes: number;
}>();
const emit = defineEmits<{
  import: [files: File[]];
  provide: [files: File[]];
  reset: [];
  start: [];
  pause: [];
  resume: [];
  retry: [key: string];
  confirm: [];
  export: [];
  discard: [];
  mode: [mode: ImportMode];
  reorder: [key: string, delta: number];
}>();

const picker = ref<HTMLInputElement>();
watch(
  () => props.fileRequest,
  () => picker.value?.click(),
);

const summary = computed(() =>
  props.task ? summarize(props.task) : { total: 0, done: 0, failed: 0, pending: 0, missing: 0 },
);
const estimate = computed(() =>
  props.task ? estimateBytes(props.task.pages, props.task.mode) : 0,
);
const quotaText = computed(() =>
  props.quotaBytes > 0 ? `本地可用约 ${formatBytes(props.quotaBytes)}` : "",
);
const overQuota = computed(
  () => props.quotaBytes > 0 && estimate.value > props.quotaBytes,
);
const percent = computed(() =>
  summary.value.total
    ? Math.round(
        ((summary.value.done + summary.value.failed) / summary.value.total) *
          100,
      )
    : 0,
);
const stateLabel: Record<string, string> = {
  preview: "预览页序",
  running: "导入中",
  paused: "已暂停",
  staged: "待确认",
  quota: "空间不足",
};

function selected(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  if (files.length) emit("import", files);
}
function provided(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  if (files.length) emit("provide", files);
}
</script>

<template>
  <div class="library-tools">
    <template v-if="!task">
      <label class="import-button"
        ><Upload :size="15" /> 导入漫画<input
          aria-label="导入漫画图片"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          @change="selected" /></label
      ><button class="subtle-button" @click="emit('reset')">
        <BookOpen :size="14" /> 内置漫画
      </button>
    </template>

    <div v-else class="import-task">
      <div class="task-head">
        <strong>{{ task.title }}</strong>
        <span class="task-state" :class="{ warn: task.state === 'quota' }">{{
          stateLabel[task.state]
        }}</span>
      </div>

      <template v-if="task.state === 'preview'">
        <div class="mode-toggle" role="radiogroup" aria-label="导入模式">
          <button
            :class="{ active: task.mode === 'fidelity' }"
            @click="emit('mode', 'fidelity')"
          >
            保真原图</button
          ><button
            :class="{ active: task.mode === 'saver' }"
            @click="emit('mode', 'saver')"
          >
            节省空间
          </button>
        </div>
        <p class="task-estimate">
          预计占用 <b>{{ formatBytes(estimate) }}</b>
          <template v-if="quotaText"> · {{ quotaText }}</template>
        </p>
        <p v-if="overQuota" class="task-hint warn">
          预计超出本地可用额度{{
            task.mode === "fidelity" ? "，可改用「节省空间」" : ""
          }}；超限时可导出已完成部分
        </p>
        <p v-if="task.mode === 'saver'" class="task-hint">
          长边压缩至 1600px 并转码 JPEG，GIF 将转为静态图
        </p>
      </template>

      <template v-else>
        <div class="progress-track">
          <div class="progress-fill" :style="{ width: `${percent}%` }"></div>
        </div>
        <p class="task-estimate">
          已完成 <b>{{ summary.done }}</b> / {{ summary.total }} 页
          <template v-if="summary.failed">
            · <b class="warn-text">{{ summary.failed }} 页失败</b></template
          >
        </p>
      </template>

      <ul class="page-list">
        <li
          v-for="(p, i) in task.pages"
          :key="p.key"
          class="page-row"
          :class="{ failed: p.status === 'failed' }"
        >
          <span class="idx">{{ String(i + 1).padStart(2, "0") }}</span>
          <span class="name" :title="p.error || p.name">{{ p.name }}</span>
          <span class="meta">{{ formatBytes(p.size) }}</span>
          <Loader2
            v-if="p.status === 'processing' || (task.state === 'preview' && p.status === 'pending' && !p.width)"
            :size="12"
            class="spin"
          />
          <Check v-else-if="p.status === 'done'" :size="12" class="ok-icon" />
          <AlertTriangle
            v-else-if="p.status === 'failed'"
            :size="12"
            class="warn-text"
          />
          <span v-if="task.state === 'preview'" class="row-moves">
            <button
              v-if="p.status === 'failed'"
              title="重新选择该页文件"
              @click="emit('retry', p.key)"
            >
              <RotateCcw :size="11" />
            </button>
            <button title="上移" @click="emit('reorder', p.key, -1)">
              <ChevronUp :size="12" /></button
            ><button title="下移" @click="emit('reorder', p.key, 1)">
              <ChevronDown :size="12" />
            </button>
          </span>
          <button
            v-else-if="p.status === 'failed'"
            title="重试此页"
            @click="emit('retry', p.key)"
          >
            <RotateCcw :size="12" />
          </button>
        </li>
      </ul>

      <p v-if="task.state === 'staged'" class="task-hint">
        确认后章节才会出现在目录；{{
          summary.missing ? `${summary.missing} 页将以缺页占位标记。` : "全部页已就绪。"
        }}阅读进度与书签不受影响。
      </p>
      <p v-if="task.state === 'quota'" class="task-hint warn">
        本地空间不足，进度可能无法保存。可导出已完成部分备份；腾出空间后继续，或放弃任务。
      </p>

      <div class="task-actions">
        <template v-if="task.state === 'preview'">
          <button class="primary" @click="emit('start')">
            <Play :size="13" /> 开始导入</button
          ><button class="danger" @click="emit('discard')">取消</button>
        </template>
        <template v-else-if="task.state === 'running'">
          <button @click="emit('pause')"><Pause :size="13" /> 暂停</button>
        </template>
        <template v-else-if="task.state === 'paused'">
          <button class="primary" @click="emit('resume')">
            <Play :size="13" /> 继续</button
          ><button class="danger" @click="emit('discard')">放弃</button>
        </template>
        <template v-else-if="task.state === 'staged'">
          <button class="primary" @click="emit('confirm')">
            <Check :size="13" /> 确认入库{{
              summary.missing ? `（缺 ${summary.missing} 页）` : ""
            }}</button
          ><button @click="emit('export')">
            <Download :size="13" /> 导出</button
          ><button class="danger" @click="emit('discard')">放弃</button>
        </template>
        <template v-else-if="task.state === 'quota'">
          <button class="primary" @click="emit('export')">
            <Download :size="13" /> 导出已完成部分</button
          ><button
            v-if="!task.committedChapterId && summary.pending"
            @click="emit('resume')"
          >
            <Play :size="13" /> 继续</button
          ><button v-if="task.committedChapterId" @click="emit('confirm')">
            <Check :size="13" /> 重试保存</button
          ><button class="danger" @click="emit('discard')">放弃任务</button>
        </template>
      </div>
    </div>

    <input
      ref="picker"
      class="visually-hidden"
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif"
      multiple
      tabindex="-1"
      @change="provided"
    />
    <p v-if="message" class="notice" role="status">{{ message }}</p>
  </div>
</template>
