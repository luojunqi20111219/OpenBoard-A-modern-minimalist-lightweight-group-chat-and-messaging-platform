import os
import json
import torch
import argparse
from torchvision import transforms, models
from PIL import Image

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
DATA_TABLE_PATH = r"C:\Users\32709\OneDrive\Desktop\任务三全部工程文件\data_table.json"
CLASS_MAPPING_PATH = r"C:\Users\32709\OneDrive\Desktop\任务三全部工程文件\class_mapping.json"
MODEL_WEIGHTS_PATH = r"C:\Users\32709\OneDrive\Desktop\任务三全部工程文件\best_model.pth"

def load_data_table():
    """读取本地 JSON 文学意象信息表"""
    with open(DATA_TABLE_PATH, "r", encoding="utf-8") as f:
        return json.load(f)

def find_mapping(plant_name, data_table):
    """根据识别结果查找所属季节和对应的文学作品"""
    for item in data_table:
        # data_table中的"图像识别方式"是个列表，我们在里面查找
        if plant_name in item.get("图像识别方式", []):
            return item.get("季节"), item.get("文学作品")
                
    return None, None

def predict_image(image_path, data_table=None):
    # 1. 检查必要文件并加载类别映射
    if not os.path.exists(CLASS_MAPPING_PATH):
        raise FileNotFoundError(f"找不到类别映射文件 {CLASS_MAPPING_PATH}，请先运行训练脚本。")
    if not os.path.exists(MODEL_WEIGHTS_PATH):
        raise FileNotFoundError(f"找不到模型权重文件 {MODEL_WEIGHTS_PATH}，请先运行训练脚本。")
        
    with open(CLASS_MAPPING_PATH, "r", encoding="utf-8") as f:
        idx_to_class = json.load(f)

    num_classes = len(idx_to_class)

    # 2. 构建模型并加载预训练权重
    model = models.mobilenet_v2()
    # 替换最后的分类层
    model.classifier[1] = torch.nn.Linear(model.last_channel, num_classes)
    model.load_state_dict(torch.load(MODEL_WEIGHTS_PATH, map_location=DEVICE))
    model.to(DEVICE)
    model.eval()

    # 3. 图像预处理 (与训练时保持一致)
    transform = transforms.Compose([
        transforms.Resize((224, 224)),
        transforms.ToTensor(),
        transforms.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225])
    ])

    image = Image.open(image_path).convert("RGB")
    input_tensor = transform(image).unsqueeze(0).to(DEVICE)

    # 4. 模型推理
    with torch.no_grad():
        outputs = model(input_tensor)
        
        # --- 新增优化：约束推断 (Constrained Inference) ---
        # 如果赛场上 data_table 只填了 2-4 种植物，强制屏蔽其他不在表里的分类，防止由于背景杂乱导致的误判
        if data_table is not None:
            valid_plants = set()
            for item in data_table:
                valid_plants.update(item.get("图像识别方式", []))
            
            # 找到在 JSON 中存在的合法类别的 ID
            valid_indices = []
            for idx_str, name in idx_to_class.items():
                if name in valid_plants:
                    valid_indices.append(int(idx_str))
                    
            # 如果表里配置了合法植物，就把不在表里的植物识别概率强行降为负无穷
            if valid_indices:
                mask = torch.ones(outputs.shape[1], dtype=torch.bool, device=DEVICE)
                mask[valid_indices] = False
                outputs[0, mask] = -float('inf')
        # ---------------------------------------------------

        _, predicted = torch.max(outputs, 1)
        # 将 PyTorch index 转为字符串，去匹配 JSON 加载出来的字典键
        predicted_idx = str(predicted.item()) 
        plant_name = idx_to_class[predicted_idx]
        
    return plant_name

def main():
    parser = argparse.ArgumentParser(description="Image Inference & Logic Output Script")
    parser.add_argument("image_path", type=str, help="请输入要识别的测试图片路径", nargs='?')
    args = parser.parse_args()

    # 如果命令行没有带参数，则用 input() 获取图片路径
    image_path = args.image_path
    if not image_path:
        image_path = input("请输入要识别的测试图片路径: ").strip()
        # 去掉输入路径两边可能被加上的引号
        image_path = image_path.strip('"').strip("'")

    if not os.path.exists(image_path):
        print(f"错误: 找不到图片 {image_path}")
        return

    # 全局：先加载配置数据表
    try:
        data_table = load_data_table()
    except Exception as e:
        print(f"加载 data_table.json 失败: {e}")
        return

    # A: 执行图片识别阶段
    try:
        # 将 data_table 传入，用于前置屏蔽没考到的植物
        plant_name = predict_image(image_path, data_table)
        print(f"【模型识别结果】：{plant_name}")
    except Exception as e:
        print(f"推理失败: {e}")
        return

    # B: 执行业务逻辑（意象映射）阶段
    try:
        season, literature = find_mapping(plant_name, data_table)

        if season and literature:
            # 严格按照规定格式输出
            print(f"这与{season}有关，联想到{literature}")
        else:
            print(f"对不起，我无法在信息库中找到关于“{plant_name}”的文学意象映射。")
    except Exception as e:
        print(f"映射逻辑处理失败: {e}")

if __name__ == "__main__":
    main()
