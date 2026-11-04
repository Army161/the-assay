// Evaluates a LightGBM binary model exported by the scanner's model/03_train_export.py (dump_model tree structures).
// Numerical splits only. missing_type 'NaN': a missing value follows default_left; 'None': missing counts as 0.
export interface TreeNode {
  split_feature?: number;
  threshold?: number;
  default_left?: boolean;
  missing_type?: string;
  left_child?: TreeNode;
  right_child?: TreeNode;
  leaf_value?: number;
}
export interface ModelJson {
  features: string[];
  trees: TreeNode[];
  rounds?: number;
}
export interface Model {
  features: string[];
  trees: TreeNode[];
  index: Record<string, number>;
}

export function loadModel(json: ModelJson): Model {
  const index = Object.fromEntries(json.features.map((f, i) => [f, i]));
  return { features: json.features, trees: json.trees, index };
}

function leaf(node: TreeNode, x: (number | null)[]): number {
  while (node.leaf_value === undefined) {
    const v = x[node.split_feature!];
    let left: boolean;
    if (v === null || v === undefined || Number.isNaN(v)) {
      if (node.missing_type === "NaN") left = !!node.default_left;
      else left = 0 <= node.threshold!;
    } else left = v <= node.threshold!;
    node = left ? node.left_child! : node.right_child!;
  }
  return node.leaf_value;
}

export function predictRaw(model: Model, x: (number | null)[]) {
  let s = 0;
  for (const t of model.trees) s += leaf(t, x);
  return s;
}

export function predict(model: Model, featureMap: Record<string, number | null | undefined>) {
  const x = model.features.map((f) => {
    const v = featureMap[f];
    return v === undefined ? null : v;
  });
  return 1 / (1 + Math.exp(-predictRaw(model, x)));
}
