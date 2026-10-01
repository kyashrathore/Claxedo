-- A workspace belongs to its owner and admits nobody else, so nothing reads
-- whether ordinary org members may see it. The column's own CHECK goes with
-- it; no index, trigger or view references it.
alter table workspaces drop column org_member_visible;
