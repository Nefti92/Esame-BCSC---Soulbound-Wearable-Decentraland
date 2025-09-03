import bpy

# Nome dell'oggetto e del materiale
object_name = 'FaceMask'
material_name = 'Viso'

# Percorso base per il recupero da cartella temporanea temporary_files da configurare in base alla posizione. Funziona quello assoluto
base_path = 'C:/Users/samue/Desktop/Progetti/BCSC/webcam-wallet/backend/temporary_files/'

# Trova l'oggetto specificato
obj = bpy.data.objects.get(object_name)
if obj is None:
    raise ValueError(f"Oggetto '{object_name}' non trovato nel file Blender")

# Trova il materiale specificato
mat = bpy.data.materials.get(material_name)
if mat is None:
    raise ValueError(f"Materiale '{material_name}' non trovato nel file Blender")

# Carica l'immagine
image_path = base_path + 'photo.png'    
image = bpy.data.images.load(image_path)

# Aggiungi l'immagine come texture al materiale
# Crea un nodo texture
if not mat.use_nodes:
    mat.use_nodes = True
nodes = mat.node_tree.nodes
texture_node = nodes.new(type='ShaderNodeTexImage')
texture_node.image = image

# Collega la texture al nodo Principled BSDF
bsdf = nodes.get('Principled BSDF')
if bsdf:
    mat.node_tree.links.new(texture_node.outputs['Color'], bsdf.inputs['Base Color'])
else:
    raise ValueError("Nodo Principled BSDF non trovato nel materiale")

output_path = base_path + 'mask.glb'
bpy.ops.export_scene.gltf(filepath=output_path)