import type { Translations } from "@/i18n"

const en = {
  "files.comment.submit": "Comment",
  "files.comment.save": "Save",
  "files.search": "Search files...",
  "files.clearSearch": "Clear search",
  "files.showMore": "Show {{count}} more",
  "files.noResults": "No files found",
  "files.tree": "File tree",
  "files.loading": "Loading files",
  "files.retry": "Retry",
  "files.loadFailed": "The files could not be loaded",
  "files.tab.loading": "Loading...",
  "files.tab.empty": "No content",
  "files.tab.binary": "Binary file — no inline preview available.",
  "files.tab.copyPath": "Copy path",
  "files.tab.copiedPath": "Copied path",
}

export type FilesKey = keyof typeof en

const zh: Partial<Record<FilesKey, string>> = {
  "files.search": "搜索文件",
}

const zht: Partial<Record<FilesKey, string>> = {
  "files.search": "搜尋檔案",
}

const ko: Partial<Record<FilesKey, string>> = {
  "files.search": "파일 검색",
}

const de: Partial<Record<FilesKey, string>> = {
  "files.search": "Dateien suchen",
}

const es: Partial<Record<FilesKey, string>> = {
  "files.search": "Buscar archivos",
}

const fr: Partial<Record<FilesKey, string>> = {
  "files.search": "Rechercher des fichiers",
}

const da: Partial<Record<FilesKey, string>> = {
  "files.search": "Søg efter filer",
}

const ja: Partial<Record<FilesKey, string>> = {
  "files.search": "ファイルを検索",
}

const pl: Partial<Record<FilesKey, string>> = {
  "files.search": "Szukaj plików",
}

const ru: Partial<Record<FilesKey, string>> = {
  "files.search": "Поиск файлов",
}

const bs: Partial<Record<FilesKey, string>> = {
  "files.search": "Pretraži datoteke",
}

const ar: Partial<Record<FilesKey, string>> = {
  "files.search": "بحث عن الملفات",
}

const no: Partial<Record<FilesKey, string>> = {
  "files.search": "Søk etter filer",
}

const br: Partial<Record<FilesKey, string>> = {
  "files.search": "Buscar arquivos",
}

const th: Partial<Record<FilesKey, string>> = {
  "files.search": "ค้นหาไฟล์",
}

const tr: Partial<Record<FilesKey, string>> = {
  "files.search": "Dosya ara",
}

export const filesDictionary = {
  en,
  ar,
  br,
  bs,
  da,
  de,
  es,
  fr,
  ja,
  ko,
  no,
  pl,
  ru,
  th,
  tr,
  zh,
  zht,
} satisfies Translations<FilesKey>
