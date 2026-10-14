"""Converte o shapefile para os dois arquivos usados pelo mapa."""
import json
import math
import shutil
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def converter(source, output):
    import shapefile
    from pyproj import CRS, Transformer

    for extension in (".shp", ".shx", ".dbf", ".prj", ".cpg"):
        if not source.with_suffix(extension).exists():
            raise ValueError(f"Falta o arquivo {source.with_suffix(extension).name}")
    encoding = source.with_suffix(".cpg").read_text(encoding="utf-8-sig").strip()
    encoding = {"65001": "utf-8", "1252": "cp1252"}.get(encoding, encoding)
    try:
        wkt = source.with_suffix(".prj").read_text(encoding="utf-8-sig")
    except UnicodeDecodeError:
        wkt = source.with_suffix(".prj").read_text(encoding="cp1252")
    crs = CRS.from_wkt(wkt)
    transform = Transformer.from_crs(crs, "EPSG:4326", always_xy=True)

    def coordinates(value):
        if isinstance(value[0], (float, int)):
            x, y = transform.transform(value[0], value[1], errcheck=True)
            if not (math.isfinite(x) and math.isfinite(y) and -180 <= x <= 180 and -90 <= y <= 90):
                raise ValueError("Coordenada inválida após conversão. Confira o arquivo .prj.")
            return [x, y]
        return [coordinates(child) for child in value]

    features = []
    sem_geometria = []
    with shapefile.Reader(str(source), encoding=encoding) as reader:
        names = [f[0].lower() for f in reader.fields[1:]]
        if "numero" not in names:
            raise ValueError("O shapefile precisa conter o campo numero para os rótulos e grupos.")
        for index, record in enumerate(reader.iterShapeRecords(), 1):
            # NULL é um registro SHP válido, mas não tem polígono para desenhar.
            if record.shape.shapeType == shapefile.NULL or not record.shape.points:
                sem_geometria.append(record.record.oid + 1)
                continue
            raw = dict(zip(names, record.record))
            props = {}
            for name in ("rua", "numero", "numero2", "bairro", "nome", "inconsiste"):
                value = raw.get(name)
                props[name] = str(value).strip() if value is not None and str(value).strip() else None
            props["inconsistente_flag"] = bool(props["inconsiste"])
            props["busca"] = " ".join(props[k] for k in ("rua", "numero", "numero2", "bairro", "nome") if props[k])
            geometry = record.shape.__geo_interface__
            if geometry["type"] not in ("Polygon", "MultiPolygon"):
                raise ValueError(f"Feição {index} não é um polígono.")
            geometry["coordinates"] = coordinates(geometry["coordinates"])
            features.append({"type": "Feature", "properties": props, "geometry": geometry})
    if not features:
        raise ValueError("O shapefile não contém lotes. Os dados anteriores foram mantidos.")
    metadata = {
        "atualizado_em": datetime.now().astimezone().isoformat(timespec="seconds"),
        "arquivo_origem": source.name,
        "lotes_importados": len(features),
        "registros_sem_geometria": sem_geometria,
    }
    payload = json.dumps({"type": "FeatureCollection", "metadata": metadata, "features": features}, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    output.mkdir(parents=True, exist_ok=True)
    # Só substitui dados depois de validar a conversão inteira; guarda cópia anterior.
    backup = output / "backups" / datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    targets = {
        "lotes.geojson": payload,
        "lotes.js": "window.LOTES_CADASTRAIS = " + payload + ";\n",
        "ultima_atualizacao.json": json.dumps(metadata, ensure_ascii=False, indent=2),
    }
    for name in targets:
        if (output / name).exists():
            backup.mkdir(parents=True, exist_ok=True)
            shutil.copy2(output / name, backup / name)
    for name, content in targets.items():
        temporary = output / (name + ".tmp")
        temporary.write_text(content, encoding="utf-8")
        temporary.replace(output / name)
    if sem_geometria:
        print(f"Aviso: {len(sem_geometria)} registros sem geometria não podem ser desenhados.")
        print("Linhas do shapefile (contagem a partir de 1): " + ", ".join(map(str, sem_geometria)))
    print(f"Arquivos gravados em: {output.resolve()}")
    return len(features)


def main():
    sources = list((ROOT / "shp_source").glob("*.shp"))
    if len(sources) != 1:
        raise ValueError("Coloque exatamente um conjunto de shapefile na pasta shp_source.")
    total = converter(sources[0], ROOT / "data")
    print(f"Concluído: {total} lotes atualizados. Feche e abra index.html novamente.")


if __name__ == "__main__":
    try:
        main()
    except ImportError:
        print("Instale as dependências: python -m pip install -r scripts/requirements.txt")
        sys.exit(1)
    except Exception as exc:
        print(f"Falha ao atualizar: {exc}")
        sys.exit(1)
