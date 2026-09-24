import type { Translations } from "@/i18n"

const en = {
  "files.tab": "Files",
  "files.search": "Search files",
  "files.clearSearch": "Clear search",
  "files.searching": "Searching files",
  "files.noResults": "No files found",
  "files.results": "Search results",
  "files.tree": "File tree",
  "files.loading": "Loading files",
  "files.retry": "Retry",
  "files.loadFailed": "The files could not be loaded",
  "files.searchFailed": "The search failed",
  "files.readFailed": "The file could not be read",
  "files.noPlacement": "Open a project to browse its files",
  "files.missing": "This file does not exist in the workspace",
  "files.binary": "Binary file, no preview",
  "files.mark.added": "Added",
  "files.mark.deleted": "Deleted",
  "files.mark.modified": "Modified",
}

export type FilesKey = keyof typeof en

const zh: Partial<Record<FilesKey, string>> = {
  "files.tab": "文件",
  "files.search": "搜索文件",
  "files.mark.added": "已添加",
  "files.mark.deleted": "已删除",
  "files.mark.modified": "已修改",
}

const zht: Partial<Record<FilesKey, string>> = {
  "files.tab": "檔案",
  "files.search": "搜尋檔案",
  "files.mark.added": "已新增",
  "files.mark.deleted": "已刪除",
  "files.mark.modified": "已修改",
}

const ko: Partial<Record<FilesKey, string>> = {
  "files.tab": "파일",
  "files.search": "파일 검색",
  "files.mark.added": "추가됨",
  "files.mark.deleted": "삭제됨",
  "files.mark.modified": "수정됨",
}

const de: Partial<Record<FilesKey, string>> = {
  "files.tab": "Dateien",
  "files.search": "Dateien suchen",
  "files.mark.added": "Hinzugefügt",
  "files.mark.deleted": "Gelöscht",
  "files.mark.modified": "Geändert",
}

const es: Partial<Record<FilesKey, string>> = {
  "files.tab": "Archivos",
  "files.search": "Buscar archivos",
  "files.mark.added": "Añadido",
  "files.mark.deleted": "Eliminado",
  "files.mark.modified": "Modificado",
}

const fr: Partial<Record<FilesKey, string>> = {
  "files.tab": "Fichiers",
  "files.search": "Rechercher des fichiers",
  "files.mark.added": "Ajouté",
  "files.mark.deleted": "Supprimé",
  "files.mark.modified": "Modifié",
}

const da: Partial<Record<FilesKey, string>> = {
  "files.tab": "Filer",
  "files.search": "Søg efter filer",
  "files.mark.added": "Tilføjet",
  "files.mark.deleted": "Slettet",
  "files.mark.modified": "Ændret",
}

const ja: Partial<Record<FilesKey, string>> = {
  "files.tab": "ファイル",
  "files.search": "ファイルを検索",
  "files.mark.added": "追加",
  "files.mark.deleted": "削除",
  "files.mark.modified": "変更",
}

const pl: Partial<Record<FilesKey, string>> = {
  "files.tab": "Pliki",
  "files.search": "Szukaj plików",
  "files.mark.added": "Dodany",
  "files.mark.deleted": "Usunięty",
  "files.mark.modified": "Zmodyfikowany",
}

const ru: Partial<Record<FilesKey, string>> = {
  "files.tab": "Файлы",
  "files.search": "Поиск файлов",
  "files.mark.added": "Добавлен",
  "files.mark.deleted": "Удалён",
  "files.mark.modified": "Изменён",
}

const bs: Partial<Record<FilesKey, string>> = {
  "files.tab": "Datoteke",
  "files.search": "Pretraži datoteke",
  "files.mark.added": "Dodano",
  "files.mark.deleted": "Obrisano",
  "files.mark.modified": "Izmijenjeno",
}

const ar: Partial<Record<FilesKey, string>> = {
  "files.tab": "الملفات",
  "files.search": "بحث عن الملفات",
  "files.mark.added": "مُضاف",
  "files.mark.deleted": "محذوف",
  "files.mark.modified": "مُعدّل",
}

const no: Partial<Record<FilesKey, string>> = {
  "files.tab": "Filer",
  "files.search": "Søk etter filer",
  "files.mark.added": "Lagt til",
  "files.mark.deleted": "Slettet",
  "files.mark.modified": "Endret",
}

const br: Partial<Record<FilesKey, string>> = {
  "files.tab": "Arquivos",
  "files.search": "Buscar arquivos",
  "files.mark.added": "Adicionado",
  "files.mark.deleted": "Excluído",
  "files.mark.modified": "Modificado",
}

const th: Partial<Record<FilesKey, string>> = {
  "files.tab": "ไฟล์",
  "files.search": "ค้นหาไฟล์",
  "files.mark.added": "เพิ่มแล้ว",
  "files.mark.deleted": "ลบแล้ว",
  "files.mark.modified": "แก้ไขแล้ว",
}

const tr: Partial<Record<FilesKey, string>> = {
  "files.tab": "Dosyalar",
  "files.search": "Dosya ara",
  "files.mark.added": "Eklendi",
  "files.mark.deleted": "Silindi",
  "files.mark.modified": "Değiştirildi",
}

export const dictionary = { en, ar, br, bs, da, de, es, fr, ja, ko, no, pl, ru, th, tr, zh, zht } satisfies Translations<FilesKey>
