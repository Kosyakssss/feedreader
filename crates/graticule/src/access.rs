use accesskit::{Action, Node, NodeId, Rect as Bounds, Role, TreeId, TreeInfo, TreeUpdate};

use crate::text::Text;
use crate::ui::{Rect, Run};

pub const ROOT: NodeId = NodeId(1);
const HIT: u64 = 2 << 32;
const RUN: u64 = 3 << 32;
const FIELD: u64 = 4 << 32;
const PICTURE: u64 = 5 << 32;

pub fn hit_of(id: NodeId) -> Option<usize> {
    (id.0 & !0xffff_ffff == HIT).then_some((id.0 & 0xffff_ffff) as usize)
}

fn bounds(r: Rect) -> Bounds {
    Bounds { x0: r.x as f64, y0: r.y as f64, x1: r.right() as f64, y1: r.bottom() as f64 }
}

pub struct Frame<'a> {
    pub title: &'a str,
    pub hits: &'a [Rect],
    pub runs: &'a [Run],
    pub fields: &'a [Rect],
    pub pictures: &'a [(Rect, &'static str)],
    pub focused: Option<(Rect, &'a str)>,
}

pub fn tree(f: Frame, text: &Text) -> TreeUpdate {
    let mut nodes: Vec<(NodeId, Node)> = Vec::new();
    let mut children = Vec::new();
    let mut labels: Vec<Option<String>> = vec![None; f.hits.len()];
    let mut order: Vec<usize> = Vec::new();
    for (i, run) in f.runs.iter().enumerate() {
        let Some(src) = text.source(run.key) else { continue };
        let (cx, cy) = (run.rect.x + run.rect.w / 2.0, run.rect.y + run.rect.h / 2.0);
        match f.hits.iter().rposition(|h| h.contains(cx, cy)) {
            Some(h) => {
                if labels[h].is_none() {
                    order.push(h);
                    children.push(NodeId(HIT + h as u64));
                }
                let label = labels[h].get_or_insert_with(String::new);
                if !label.is_empty() {
                    label.push(' ');
                }
                label.push_str(src.trim());
            }
            None => {
                let id = NodeId(RUN + i as u64);
                let mut node = Node::new(Role::Label);
                node.set_value(src.trim());
                node.set_bounds(bounds(run.rect));
                nodes.push((id, node));
                children.push(id);
            }
        }
    }
    for h in order {
        let id = NodeId(HIT + h as u64);
        let mut node = Node::new(Role::Button);
        node.set_label(labels[h].take().unwrap_or_default());
        node.set_bounds(bounds(f.hits[h]));
        node.add_action(Action::Click);
        nodes.push((id, node));
    }
    for (i, (r, label)) in f.pictures.iter().enumerate() {
        let id = NodeId(PICTURE + i as u64);
        let mut node = Node::new(Role::Image);
        node.set_label(*label);
        node.set_bounds(bounds(*r));
        nodes.push((id, node));
        children.push(id);
    }
    let mut focus = ROOT;
    for (i, r) in f.fields.iter().enumerate() {
        let id = NodeId(FIELD + i as u64);
        let mut node = Node::new(Role::TextInput);
        node.set_bounds(bounds(*r));
        if let Some((rect, value)) = f.focused
            && rect == *r
        {
            node.set_value(value);
            focus = id;
        }
        nodes.push((id, node));
        children.push(id);
    }
    let mut root = Node::new(Role::Window);
    root.set_label(f.title);
    root.set_children(children);
    nodes.push((ROOT, root));
    TreeUpdate { nodes, tree: Some(TreeInfo::new(ROOT)), tree_id: TreeId::ROOT, focus }
}
