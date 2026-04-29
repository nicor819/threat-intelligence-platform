import networkx as nx
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from pathlib import Path

try:
    from pyvis.network import Network
    PYVIS_AVAILABLE = True
except ImportError:
    PYVIS_AVAILABLE = False


NODE_COLORS = {
    "target":    "#e74c3c",
    "ip":        "#3498db",
    "asn":       "#9b59b6",
    "country":   "#2ecc71",
    "registrar": "#f39c12",
    "isp":       "#1abc9c",
    "malware":   "#c0392b",
    "default":   "#95a5a6",
}

NODE_SHAPES = {
    "target":    "D",   # diamond
    "malware":   "s",   # square
    "default":   "o",   # circle
}


class GraphBuilder:
    def __init__(self, output_dir: str = "output/graphs", cfg: dict = None):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.cfg = cfg or {}

    def build(self, profile: dict) -> dict:
        target = profile["target"]
        nodes = profile.get("graph_nodes", [])
        edges = profile.get("graph_edges", [])

        G = nx.DiGraph()
        for n in nodes:
            G.add_node(n["id"], node_type=n.get("type", "default"), label=n.get("label", n["id"]))
        for e in edges:
            G.add_edge(e["source"], e["target"], label=e.get("label", ""))

        safe_name = target.replace(".", "_").replace("/", "_")
        png_path = self.output_dir / f"{safe_name}_graph.png"
        html_path = self.output_dir / f"{safe_name}_graph.html"

        self._render_matplotlib(G, target, png_path)

        html_out = None
        if PYVIS_AVAILABLE and self.cfg.get("save_html", True):
            self._render_pyvis(G, target, html_path)
            html_out = str(html_path)

        return {"png": str(png_path), "html": html_out}

    def _render_matplotlib(self, G: nx.DiGraph, target: str, path: Path):
        fig, ax = plt.subplots(figsize=(14, 10))
        ax.set_facecolor("#1a1a2e")
        fig.patch.set_facecolor("#1a1a2e")

        layout = self.cfg.get("layout", "spring")
        if layout == "circular":
            pos = nx.circular_layout(G)
        elif layout == "hierarchical":
            pos = nx.kamada_kawai_layout(G)
        else:
            pos = nx.spring_layout(G, k=2.5, seed=42)

        node_size = self.cfg.get("node_size", 1500)
        font_size = self.cfg.get("font_size", 9)

        for ntype in set(nx.get_node_attributes(G, "node_type").values()) | {"default"}:
            nodelist = [n for n, d in G.nodes(data=True) if d.get("node_type", "default") == ntype]
            if not nodelist:
                continue
            color = NODE_COLORS.get(ntype, NODE_COLORS["default"])
            shape = NODE_SHAPES.get(ntype, NODE_SHAPES["default"])
            nx.draw_networkx_nodes(
                G, pos, nodelist=nodelist,
                node_color=color, node_shape=shape,
                node_size=node_size, alpha=0.9, ax=ax,
            )

        nx.draw_networkx_labels(G, pos, font_size=font_size, font_color="white", ax=ax)
        nx.draw_networkx_edges(
            G, pos, edge_color="#ecf0f1", alpha=0.5,
            arrows=True, arrowsize=15, width=1.2, ax=ax,
        )
        edge_labels = nx.get_edge_attributes(G, "label")
        nx.draw_networkx_edge_labels(
            G, pos, edge_labels=edge_labels,
            font_size=7, font_color="#bdc3c7", ax=ax,
        )

        # Leyenda
        legend_handles = [
            mpatches.Patch(color=c, label=t) for t, c in NODE_COLORS.items() if t != "default"
        ]
        ax.legend(handles=legend_handles, loc="upper left", facecolor="#2c2c54", labelcolor="white", fontsize=8)
        ax.set_title(f"Threat Profile: {target}", color="white", fontsize=13, pad=12)
        ax.axis("off")

        plt.tight_layout()
        plt.savefig(path, dpi=150, bbox_inches="tight", facecolor=fig.get_facecolor())
        plt.close(fig)

    def _render_pyvis(self, G: nx.DiGraph, target: str, path: Path):
        net = Network(height="750px", width="100%", bgcolor="#1a1a2e", font_color="white", directed=True)
        net.barnes_hut(gravity=-8000, central_gravity=0.3, spring_length=150)

        for node_id, data in G.nodes(data=True):
            ntype = data.get("node_type", "default")
            color = NODE_COLORS.get(ntype, NODE_COLORS["default"])
            size = 30 if node_id == target else 18
            net.add_node(node_id, label=data.get("label", node_id), color=color, size=size, title=f"Type: {ntype}")

        for src, dst, data in G.edges(data=True):
            net.add_edge(src, dst, label=data.get("label", ""), color="#7f8c8d")

        net.set_options("""
        var options = {
          "edges": {"arrows": {"to": {"enabled": true, "scaleFactor": 0.6}}},
          "physics": {"enabled": true}
        }
        """)
        net.save_graph(str(path))
