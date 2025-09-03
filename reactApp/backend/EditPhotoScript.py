from PIL import Image

# Carica immagine
image = Image.open("temporary_files/photo.png")
width, height = image.size

# Calcola coordinate del ritaglio centrato
left = (width - 95) // 2 - 9
top = (height - 140) // 2 + 10
right = left + 95
bottom = top + 140

# Esegui ritaglio
cropped = image.crop((left, top, right, bottom))
cropped.save("temporary_files/photo.png")