export default function FoodCard({ food, onDelete }) {
  return (
    <div className="bg-white rounded-xl shadow-lg p-4 w-60 m-2 flex flex-col items-center">
      <img className="rounded-lg w-full h-36 object-cover mb-2" src={food.image || "https://via.placeholder.com/150"} alt={food.name} />
      <h3 className="font-bold text-lg">{food.name}</h3>
      <p className="text-sm text-gray-600">{food.description}</p>
      <p className="text-purple-700 font-bold">₹{food.price}</p>
      {onDelete && <button className="bg-red-500 text-white p-1 mt-2 rounded" onClick={()=>onDelete(food._id)}>Delete</button>}
    </div>
  );
}
